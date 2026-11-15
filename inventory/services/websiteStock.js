// inventory/services/websiteStock.js
// Makes the website's stock numbers follow inventory, so a sale anywhere (POS, website order,
// return, stocktake…) shows on the website. Inventory is the only place stock really changes;
// the website's `stock` fields become a copy of "available to sell":
//
//   available = on hand on shelves (not In Transit / Damaged) − reserved for orders
//               − still needed by new orders not reserved yet
//   a multi-box kit = the number of complete kits its boxes make.
//
// Off unless INVENTORY_WEBSITE_STOCK=true. It needs website orders to come into inventory too
// (INVENTORY_WEBSITE_ORDERS not "false"): otherwise an online sale lowers the website's number,
// inventory never hears of it, and the next push would put the sold item back on sale.
//
// Pushes are batched (a short wait collects every change of one sale) and recalculated from the
// database each time, so they are always correct whichever order they run in. Only numbers that
// differ are written.
import mongoose from "mongoose";
import WebsiteProduct from "../../models/Product.js";
import { Product, Variant } from "../models/Catalog.js";
import Location from "../models/Location.js";
import { Order } from "../models/Order.js";
import { StockLevel } from "../models/Stock.js";
import { SYSTEM_TYPES } from "./locationTree.js";
import { kitAvailability } from "./movementRules.js";

const s = (v) => (v == null ? v : String(v));
const DELAY_MS = 1500;

export function websiteStockEnabled() {
  return process.env.INVENTORY_WEBSITE_STOCK === "true" && process.env.INVENTORY_WEBSITE_ORDERS !== "false";
}

// ---------------------------------------------------------------- batching

const pendingVariants = new Set();
const pendingProducts = new Set();
let timer = null;
let running = Promise.resolve();

/** After stock of these inventory variants changed (any kind: item, kit or box). */
export function scheduleWebsiteStock(variantIds = []) {
  if (!websiteStockEnabled()) return;
  for (const id of variantIds) if (id) pendingVariants.add(s(id));
  arm();
}

/** After a website product changed (e.g. someone typed a stock number in the website admin). */
export function scheduleWebsiteProduct(websiteProductId) {
  if (!websiteStockEnabled() || !websiteProductId) return;
  pendingProducts.add(s(websiteProductId));
  arm();
}

function arm() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const variants = [...pendingVariants];
    const webProducts = [...pendingProducts];
    pendingVariants.clear();
    pendingProducts.clear();
    running = running
      .then(() => flush(variants, webProducts))
      .catch((e) => console.error("[inventory] website stock:", e.message));
  }, DELAY_MS);
}

async function flush(variantIds, websiteProductIds) {
  const productIds = new Set();
  if (variantIds.length) {
    const variants = await Variant.find({ _id: { $in: variantIds } }).select("productId kind").lean();
    for (const v of variants) productIds.add(s(v.productId));
    // A box changes how many complete kits there are.
    const boxes = variants.filter((v) => v.kind === "COMPONENT").map((v) => v._id);
    if (boxes.length) {
      const kits = await Variant.find({ "components.componentVariantId": { $in: boxes } }).select("productId").lean();
      for (const k of kits) productIds.add(s(k.productId));
    }
  }
  if (websiteProductIds.length) {
    const linked = await Product.find({ "website.productId": { $in: websiteProductIds } }).select("_id").lean();
    for (const p of linked) productIds.add(s(p._id));
  }
  if (productIds.size) await pushWebsiteStock({ productIds: [...productIds] });
}

// ---------------------------------------------------------------- the calculation

/**
 * Works out each linked website product's stock from inventory and writes the numbers that differ.
 * productIds: inventory product ids (omit for every website-linked product).
 * dryRun: only report what would change.
 * Returns { checked, changed, items: [{ product, variant, website, inventory }] } (items = changes).
 */
export async function pushWebsiteStock({ productIds, dryRun = false } = {}) {
  const filter = { "website.productId": { $ne: null } };
  if (productIds) filter._id = { $in: productIds };
  const products = await Product.find(filter).select("name website").lean();
  if (!products.length) return { checked: 0, changed: 0, items: [] };

  const variants = await Variant.find({ productId: { $in: products.map((p) => p._id) } })
    .select("productId kind name active websiteVariantId components")
    .lean();
  const sellable = variants.filter((v) => v.kind !== "COMPONENT");
  const boxIds = sellable.flatMap((v) => (v.kind === "KIT" ? v.components.map((c) => s(c.componentVariantId)) : []));
  const stockIds = [...new Set([...sellable.filter((v) => v.kind === "STANDARD").map((v) => s(v._id)), ...boxIds])];

  const available = await availableByVariant(stockIds);
  const free = (id) => Math.max(0, available.get(id) ?? 0);
  const quantityOf = (v) => {
    if (v.kind === "STANDARD") return free(s(v._id));
    if (!v.components?.length) return 0;
    return kitAvailability(
      v.components.map((c) => ({ variantId: s(c.componentVariantId), perKit: c.quantity, available: free(s(c.componentVariantId)) }))
    ).sellable;
  };

  const webDocs = await WebsiteProduct.collection
    .find({ _id: { $in: products.map((p) => new mongoose.Types.ObjectId(String(p.website.productId))) } })
    .project({ stock: 1, variants: 1, name: 1 })
    .toArray();
  const webById = new Map(webDocs.map((w) => [s(w._id), w]));

  const result = { checked: 0, changed: 0, items: [] };
  for (const product of products) {
    const web = webById.get(s(product.website.productId));
    if (!web) continue; // deleted on the website
    result.checked++;
    const own = sellable.filter((v) => s(v.productId) === s(product._id));
    const set = {};
    const note = (variantName, from, to) => result.items.push({ product: product.name, variant: variantName, website: from, inventory: to });

    if (web.variants?.length) {
      const stocks = web.variants.map((wv, i) => {
        const match = own.find((v) => v.websiteVariantId === s(wv._id));
        const next = match ? quantityOf(match) : 0; // a colour inventory doesn't know can't be sold
        if ((wv.stock ?? 0) !== next) {
          set[`variants.${i}.stock`] = next;
          note([wv.color, wv.dimensions].filter(Boolean).join(" / ") || `#${i + 1}`, wv.stock ?? 0, next);
        }
        return next;
      });
      const total = stocks.reduce((a, b) => a + b, 0);
      if ((web.stock ?? 0) !== total) set.stock = total;
    } else {
      const main = own.find((v) => !v.websiteVariantId && v.active) ?? own.find((v) => !v.websiteVariantId);
      const next = main ? quantityOf(main) : 0;
      if ((web.stock ?? 0) !== next) {
        set.stock = next;
        note("—", web.stock ?? 0, next);
      }
    }

    if (!Object.keys(set).length) continue;
    result.changed++;
    if (dryRun) continue;
    // Matched on the variant ids too, so a colour added or removed meanwhile can't get another's number.
    const guard = { _id: web._id };
    (web.variants ?? []).forEach((wv, i) => (guard[`variants.${i}._id`] = wv._id));
    await WebsiteProduct.collection.updateOne(guard, { $set: set });
  }
  return result;
}

/**
 * variant id → on hand − reserved at real locations, minus what new (not yet reserved) orders need.
 */
async function availableByVariant(stockIds) {
  const map = new Map(stockIds.map((id) => [id, 0]));
  if (!stockIds.length) return map;

  const systemIds = await Location.find({ type: { $in: SYSTEM_TYPES } }).distinct("_id");
  const levels = await StockLevel.aggregate([
    { $match: { variantId: { $in: stockIds.map((id) => new mongoose.Types.ObjectId(id)) }, locationId: { $nin: systemIds } } },
    { $group: { _id: "$variantId", free: { $sum: { $subtract: ["$onHand", "$reserved"] } } } },
  ]);
  for (const l of levels) map.set(s(l._id), l.free);

  // Orders waiting for allocation have reserved nothing yet, but their items are already sold.
  const newOrders = await Order.find({ status: "NEW" }).select("lines").lean();
  const lineIds = [...new Set(newOrders.flatMap((o) => o.lines.map((l) => s(l.variantId))))];
  const kits = new Map(
    (await Variant.find({ _id: { $in: lineIds }, kind: "KIT" }).select("components").lean()).map((k) => [s(k._id), k.components])
  );
  for (const order of newOrders) {
    for (const line of order.lines) {
      const parts = kits.get(s(line.variantId)) ?? [{ componentVariantId: line.variantId, quantity: 1 }];
      for (const part of parts) {
        const id = s(part.componentVariantId);
        if (map.has(id)) map.set(id, map.get(id) - part.quantity * line.quantity);
      }
    }
  }
  return map;
}
