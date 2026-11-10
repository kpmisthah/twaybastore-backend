// inventory/services/websiteOrders.js
// Website orders become delivery orders automatically — without changing any website code:
// a change stream watches the website's orders collection, and a catch-up runs at startup.
//
// Rules:
//  - only orders placed after inventory was first switched on (older ones were handled the old way);
//  - only real website orders (channel "website"; shop/Wolt sales recorded on the website are skipped);
//  - card orders once they are paid; cash-on-delivery and pickup orders straight away;
//  - each website order is imported once (unique externalId);
//  - anything that can't be imported (e.g. a product not linked yet) is kept as a "website order
//    problem" for a manager to retry — never silently dropped;
//  - an order cancelled on the website is cancelled here too while nothing has been picked.
import WebsiteOrder from "../../models/Order.js";
import WebsiteProduct from "../../models/Product.js";
import { isDuplicateKey } from "../lib/db.js";
import { badRequest, HttpError, notFound } from "../lib/http.js";
import { Product, Variant } from "../models/Catalog.js";
import { ImportIssue, Order } from "../models/Order.js";
import Setting from "../models/Setting.js";
import { audit } from "./audit.js";
import { cancelOrder, createOrder, getOrder } from "./orders.js";
import { syncFromWebsite } from "./websiteSync.js";

const s = (v) => (v == null ? v : String(v));
const SINCE_KEY = "websiteOrdersSince";

/** When inventory first started taking website orders (set once, on first start). */
export async function websiteOrdersSince() {
  const row = await Setting.findOneAndUpdate(
    { _id: SINCE_KEY },
    { $setOnInsert: { value: new Date().toISOString() } },
    { upsert: true, new: true }
  ).lean();
  return new Date(row.value);
}

/** Should this website order become a delivery order now? */
function wanted(web, since) {
  if ((web.channel ?? "website") !== "website") return false;
  if (new Date(web.createdAt) < since) return false;
  if (web.status === "Cancelled") return false;
  return web.isPaid || ["COD", "PICKUP", "CASH"].includes(web.paymentMethod);
}

/** Handles one website order (new, updated or cancelled). Never throws for data problems. */
export async function handleWebsiteOrder(web, since) {
  const externalId = s(web._id);
  const existing = await Order.findOne({ source: "WEBSITE", externalId }).select("_id status orderNumber").lean();
  if (existing) {
    if (web.status === "Cancelled") await cancelFromWebsite(existing, web);
    return "exists";
  }
  if (!wanted(web, since)) return "skipped";
  try {
    const order = await importWebsiteOrder(web);
    await ImportIssue.updateMany(
      { source: "WEBSITE", externalId, status: "OPEN" },
      { $set: { status: "RESOLVED", orderId: order.id, resolvedAt: new Date() } }
    );
    return "imported";
  } catch (e) {
    if (e instanceof HttpError && e.status < 500) {
      await recordIssue(externalId, web, e.message);
      return "problem";
    }
    throw e;
  }
}

/** Creates the delivery order. Throws HttpError 4xx for data problems. */
export async function importWebsiteOrder(web) {
  const externalId = s(web._id);
  const lines = [];
  const prices = [];
  const unknown = [];
  for (const item of web.items ?? []) {
    const qty = Math.round(Number(item.qty) || 0);
    if (qty < 1) continue;
    const variantId = await variantFor(item);
    if (variantId) {
      lines.push({ variantId, quantity: qty });
      prices.push(Number.isFinite(Number(item.price)) ? Math.round(Number(item.price) * 100) / 100 : null);
    } else {
      unknown.push([item.name, item.color, item.dimensions].filter(Boolean).join(" / ") || s(item.product) || "?");
    }
  }
  if (unknown.length) throw new HttpError(422, `Not found in inventory: ${unknown.join(", ")}`);
  if (!lines.length) throw badRequest("The order has no items");

  const ship = web.shipping ?? {};
  const contact = web.contact ?? {};
  const pickup = web.paymentMethod === "PICKUP" || /pick/i.test(web.deliveryMethod ?? "");
  const total = Number(web.finalTotal ?? web.total) || 0;
  const notes = [
    pickup ? "Customer collects (pickup)" : null,
    web.deliveryMethod && !pickup && web.deliveryMethod !== "Shipping" ? `Delivery: ${web.deliveryMethod}` : null,
    web.couponCode ? `Coupon ${web.couponCode}` : null,
    contact.email || ship.email ? `Email: ${contact.email || ship.email}` : null,
  ].filter(Boolean);

  const dto = {
    customerName: (contact.name || ship.name || "Website customer").trim().slice(0, 100),
    customerPhone: (contact.phone || ship.phone || "").trim().slice(0, 30) || undefined,
    address: [ship.address, ship.city, ship.state, ship.zip].map((x) => x?.trim()).filter(Boolean).join(", ").slice(0, 500) || undefined,
    notes: notes.join("\n") || undefined,
    paymentStatus: web.isPaid ? "PAID" : web.paymentMethod === "COD" ? "COD" : "UNPAID",
    codAmount: !web.isPaid && web.paymentMethod === "COD" ? Math.round(total * 100) / 100 : undefined,
    lines,
  };
  try {
    return await createOrder(null, dto, "WEBSITE", externalId, prices);
  } catch (e) {
    // The watcher and the catch-up can race on the same order — the unique index wins.
    if (isDuplicateKey(e)) {
      const order = await Order.findOne({ source: "WEBSITE", externalId }).select("_id").lean();
      if (order) return getOrder(order._id);
    }
    throw e;
  }
}

/**
 * The inventory variant for a website order line: the website variant chosen (by colour /
 * size, as the website itself matches them), or the product's only sellable variant.
 */
async function variantFor(item) {
  if (!item.product) return null;
  let product = await Product.findOne({ "website.productId": item.product }).select("_id").lean();
  const web = await WebsiteProduct.findById(item.product).select("-embedding").lean();
  if (!product && web) {
    await syncFromWebsite(web); // a brand-new product the watcher hasn't copied yet
    product = await Product.findOne({ "website.productId": item.product }).select("_id").lean();
  }
  if (!product) return null;

  const webVariants = web?.variants ?? [];
  if (webVariants.length) {
    const color = item.color?.trim().toLowerCase();
    const size = item.dimensions?.trim();
    const match =
      webVariants.find((v) => (!color || v.color?.trim().toLowerCase() === color) && (!size || v.dimensions?.trim() === size)) ??
      (!color && !size ? webVariants[0] : null);
    if (match) {
      const v = await Variant.findOne({ productId: product._id, websiteVariantId: s(match._id), kind: { $ne: "COMPONENT" } }).select("_id").lean();
      if (v) return s(v._id);
    }
    return null;
  }
  const own = await Variant.find({ productId: product._id, kind: { $ne: "COMPONENT" } }).select("_id active").sort({ sortOrder: 1 }).lean();
  const pick = own.find((v) => v.active) ?? own[0];
  return pick ? s(pick._id) : null;
}

async function cancelFromWebsite(order, web) {
  if (order.status === "CANCELLED") return;
  if (["NEW", "ALLOCATED"].includes(order.status)) {
    await cancelOrder(null, order._id, web.cancelReason?.trim() || "Cancelled on the website");
    return;
  }
  // Already picked or on its way: a person has to bring the goods back, so just flag it.
  const flagged = await Order.updateOne(
    { _id: order._id, notes: { $not: /Cancelled on the website/ } },
    [{ $set: { notes: { $concat: [{ $ifNull: ["$notes", ""] }, "\n⚠ Cancelled on the website — cancel here and return the goods"] } } }]
  );
  if (flagged.modifiedCount) {
    await audit({ action: "WEBSITE_ORDER_CANCELLED_LATE", entity: "Order", entityId: order._id, data: { orderNumber: order.orderNumber, status: order.status } });
  }
}

async function recordIssue(externalId, web, error) {
  const payload = JSON.parse(JSON.stringify(web));
  const now = new Date();
  try {
    await ImportIssue.updateOne(
      { source: "WEBSITE", externalId },
      {
        $set: { payload, error, lastTriedAt: now, status: "OPEN" },
        $inc: { attempts: 1 },
        $setOnInsert: { firstSeenAt: now },
      },
      { upsert: true }
    );
  } catch (e) {
    if (!isDuplicateKey(e)) throw e;
  }
}

// ---------------------------------------------------------------- problems list (managers)

export async function listIssues(status) {
  const rows = await ImportIssue.find(status ? { status } : {}).sort({ lastTriedAt: -1 }).limit(200).lean();
  return rows.map((r) => ({
    ...r,
    id: s(r._id),
    orderId: s(r.orderId) ?? null,
    resolvedById: s(r.resolvedById) ?? null,
    // What the problems page shows: who ordered what (the full website order stays stored).
    payload: {
      customerName: r.payload?.contact?.name || r.payload?.shipping?.name || undefined,
      items: (r.payload?.items ?? []).map((i) => ({
        sku: [i.name, i.color, i.dimensions].filter(Boolean).join(" / ") || undefined,
        quantity: i.qty,
      })),
    },
  }));
}

export const openIssueCount = () => ImportIssue.countDocuments({ status: "OPEN" });

/** Try the stored order again (after linking the product, adding the colour…). */
export async function retryIssue(user, id) {
  const issue = await ImportIssue.findById(id).lean();
  if (!issue) throw notFound("Problem not found");
  if (issue.status === "RESOLVED") throw badRequest("Already imported");
  // Use the website's current version of the order when it still exists.
  const web = (issue.externalId && (await WebsiteOrder.findById(issue.externalId).lean())) || issue.payload;
  try {
    const existing = await Order.findOne({ source: "WEBSITE", externalId: issue.externalId }).select("_id").lean();
    const order = existing ? await getOrder(existing._id) : await importWebsiteOrder(web);
    await ImportIssue.updateOne(
      { _id: id },
      { $set: { status: "RESOLVED", orderId: order.id, resolvedById: user.id, resolvedAt: new Date(), lastTriedAt: new Date() }, $inc: { attempts: 1 } }
    );
    await audit({ userId: user.id, action: "WEBSITE_ORDER_RETRIED", entity: "ImportIssue", entityId: id, data: { externalId: issue.externalId, orderNumber: order.orderNumber } });
    return { ok: true, orderId: order.id, orderNumber: order.orderNumber };
  } catch (e) {
    if (!(e instanceof HttpError) || e.status >= 500) throw e;
    await ImportIssue.updateOne({ _id: id }, { $set: { error: e.message, lastTriedAt: new Date() }, $inc: { attempts: 1 } });
    return { ok: false, error: e.message };
  }
}

export async function ignoreIssue(user, id) {
  const issue = await ImportIssue.findById(id).lean();
  if (!issue) throw notFound("Problem not found");
  await ImportIssue.updateOne({ _id: id }, { $set: { status: "IGNORED", resolvedById: user.id, resolvedAt: new Date() } });
  await audit({ userId: user.id, action: "WEBSITE_ORDER_IGNORED", entity: "ImportIssue", entityId: id, data: { externalId: issue.externalId, error: issue.error } });
  return { ok: true };
}

// ---------------------------------------------------------------- watcher

/** Imports website orders placed since inventory went live that aren't in yet. */
export async function catchUpWebsiteOrders() {
  const since = await websiteOrdersSince();
  const totals = { imported: 0, exists: 0, skipped: 0, problem: 0, failed: 0 };
  const orders = await WebsiteOrder.find({ createdAt: { $gte: since } }).lean();
  for (const web of orders) {
    try {
      totals[await handleWebsiteOrder(web, since)]++;
    } catch (e) {
      totals.failed++;
      console.error("[inventory] website order", s(web._id), e.message);
    }
  }
  return totals;
}

/** Live import: watches the website's orders collection. */
export async function startWebsiteOrderWatcher() {
  const since = await websiteOrdersSince();
  const queues = new Map(); // order id → promise, so changes to one order run in order
  const run = (id, task) => {
    const next = (queues.get(id) ?? Promise.resolve()).then(task).catch((e) => console.error("[inventory] website order:", e.message));
    queues.set(id, next);
    next.finally(() => queues.get(id) === next && queues.delete(id));
  };
  const start = () => {
    let stream;
    try {
      stream = WebsiteOrder.watch([{ $match: { operationType: { $in: ["insert", "update", "replace"] } } }], { fullDocument: "updateLookup" });
    } catch (e) {
      console.warn("[inventory] website order watcher unavailable:", e.message);
      return;
    }
    stream.on("change", (change) => {
      const web = change.fullDocument;
      if (web) run(s(web._id), () => handleWebsiteOrder(web, since));
    });
    stream.on("error", (e) => {
      console.warn("[inventory] website order watcher stopped, restarting in 30s:", e.message);
      stream.close().catch(() => {});
      setTimeout(() => {
        start();
        // Orders placed while the watcher was down.
        catchUpWebsiteOrders().catch((err) => console.error("[inventory] website order catch-up:", err.message));
      }, 30_000);
    });
  };
  start();
}
