// inventory/services/websiteSync.js
// Keeps inventory products in step with the website's product list.
//
// The website stays in charge of WHAT is sold (name, description, brand, category, images, price,
// colours/sizes). Inventory adds what the website doesn't have: internal codes and barcodes,
// kits and their boxes, locations and stock. So:
//  - a new website product → a new inventory product (one SKU per website variant), marked
//    "needs setup" so warehouse staff print labels and add stock;
//  - a website edit → name/price/images… copied over; new variants added; removed variants hidden;
//  - a website delete → the inventory product is set inactive (stock and history are kept).
// Stock, barcodes and kit boxes are never touched by the sync.
import WebsiteProduct from "../../models/Product.js";
import { productCode, RESERVED_CODE, variantCode, variantName } from "../lib/codes.js";
import { isDuplicateKey, nextCounter, withTransaction } from "../lib/db.js";
import { money, SKU_PATTERN } from "../lib/validate.js";
import { Category, Product, Variant } from "../models/Catalog.js";
import { audit } from "./audit.js";
import { createStandardVariant, nextFreeVariantCode, resolveTaxRate } from "./products.js";

const s = (v) => (v == null ? v : String(v));

/** Creates or updates the inventory copy of one website product. Returns what happened. */
export async function syncFromWebsite(web, userId = null) {
  try {
    const existing = await Product.findOne({ "website.productId": web._id }).lean();
    if (!existing) return web.isDeleted ? "skipped" : await createFromWebsite(web, userId);
    return await updateFromWebsite(existing, web, userId);
  } catch (e) {
    // The watcher and a full sync can race to create the same product — the unique index wins; update instead.
    if (isDuplicateKey(e, "website.productId")) {
      const existing = await Product.findOne({ "website.productId": web._id }).lean();
      return updateFromWebsite(existing, web, userId);
    }
    throw e;
  }
}

async function createFromWebsite(web, userId) {
  const categoryId = await categoryFor(web.category);
  const taxRateId = await resolveTaxRate();
  const webVariants = web.variants ?? [];
  const sku = await usableSku(web.sku) ?? (await usableSku(web.productCode));

  const product = await withTransaction(async (session) => {
    const number = await nextCounter("product", session);
    const base = productCode(number);
    const [created] = await Product.create(
      [
        {
          number,
          name: web.name?.trim() || "Unnamed product",
          description: web.description?.trim() || null,
          type: "STANDARD",
          status: "ACTIVE",
          categoryId,
          brand: web.brand?.trim() || null,
          taxRateId,
          images: (web.images ?? []).slice(0, 10),
          website: { productId: web._id, deleted: false, syncedAt: new Date() },
          needsSetup: true,
        },
      ],
      { session }
    );

    if (!webVariants.length) {
      await createStandardVariant(session, created._id, base, { sku, price: web.price }, 0);
    } else {
      for (const [i, wv] of webVariants.entries()) {
        await createStandardVariant(
          session,
          created._id,
          variantCode(base, i + 1),
          { color: wv.color, size: wv.dimensions, price: wv.price ?? web.price, websiteVariantId: s(wv._id) },
          i
        );
      }
    }
    return created;
  });

  await audit({
    userId,
    action: "WEBSITE_PRODUCT_IMPORTED",
    entity: "Product",
    entityId: product._id,
    data: { name: product.name, websiteProductId: s(web._id), variants: Math.max(1, webVariants.length) },
  });
  return "created";
}

async function updateFromWebsite(existing, web, userId) {
  const changes = {};
  const set = (field, value) => {
    if (JSON.stringify(existing[field] ?? null) !== JSON.stringify(value ?? null)) {
      changes[field] = { from: existing[field] ?? null, to: value ?? null };
    }
  };
  set("name", web.name?.trim() || existing.name);
  set("description", web.description?.trim() || null);
  set("brand", web.brand?.trim() || null);
  set("images", (web.images ?? []).slice(0, 10));
  const categoryId = await categoryFor(web.category);
  if (s(categoryId) !== s(existing.categoryId)) changes.categoryId = { from: s(existing.categoryId), to: s(categoryId) };

  const deleted = !!web.isDeleted;
  if (deleted !== !!existing.website?.deleted) {
    changes.status = { from: existing.status, to: deleted ? "INACTIVE" : "ACTIVE" };
  }

  const variantChanges = await withTransaction((session) => syncVariants(session, existing, web));

  if (!Object.keys(changes).length && !variantChanges.length) return "unchanged";

  const productUpdate = { "website.syncedAt": new Date(), "website.deleted": deleted };
  for (const [field, { to }] of Object.entries(changes)) productUpdate[field] = to;
  await Product.updateOne({ _id: existing._id }, productUpdate);
  await audit({
    userId,
    action: "WEBSITE_PRODUCT_UPDATED",
    entity: "Product",
    entityId: existing._id,
    data: { changes, variants: variantChanges },
  });
  return "updated";
}

/** Mirrors the website's colours/sizes onto inventory SKUs. Returns a list of what changed. */
async function syncVariants(session, product, web) {
  const changed = [];
  const own = await Variant.find({ productId: product._id, kind: { $ne: "COMPONENT" } }).session(session).lean();
  const webVariants = web.variants ?? [];
  const base = productCode(product.number);

  const update = async (variant, data, what) => {
    const diff = Object.fromEntries(
      Object.entries(data).filter(([k, v]) => JSON.stringify(variant[k] ?? null) !== JSON.stringify(v ?? null))
    );
    if (!Object.keys(diff).length) return;
    await Variant.updateOne({ _id: variant._id }, diff, { session });
    changed.push({ code: variant.code, [what]: diff });
  };

  if (!webVariants.length) {
    const plain = own.find((v) => !v.websiteVariantId);
    if (plain) {
      await update(plain, { price: money(web.price ?? null), ...(plain.kind === "STANDARD" && { active: true }) }, "updated");
    } else {
      const code = (await Variant.exists({ code: base }).session(session)) ? await nextFreeVariantCode(base, session) : base;
      const v = await createStandardVariant(session, product._id, code, { price: web.price }, own.length);
      changed.push({ code: v.code, added: "Default" });
    }
    for (const v of own.filter((x) => x.websiteVariantId && x.kind === "STANDARD")) await update(v, { active: false }, "hidden");
    return changed;
  }

  const webIds = new Set(webVariants.map((wv) => s(wv._id)));
  for (const [i, wv] of webVariants.entries()) {
    const match = own.find((v) => v.websiteVariantId === s(wv._id));
    const price = money(wv.price ?? web.price ?? null);
    if (!match) {
      const code = await nextFreeVariantCode(base, session);
      const v = await createStandardVariant(
        session,
        product._id,
        code,
        { color: wv.color, size: wv.dimensions, price, websiteVariantId: s(wv._id) },
        own.length + i
      );
      changed.push({ code: v.code, added: v.name });
    } else if (match.kind === "KIT") {
      // A kit keeps its own name ("Complete kit") and boxes; only the selling price follows the website.
      await update(match, { price }, "updated");
    } else {
      const color = wv.color?.trim() || null;
      const size = wv.dimensions?.trim() || null;
      await update(match, { color, size, name: variantName(color, size), price, active: true }, "updated");
    }
  }
  // Variants removed on the website, and the plain SKU once the website product has variants.
  for (const v of own.filter((x) => x.kind === "STANDARD" && x.active && (!x.websiteVariantId || !webIds.has(x.websiteVariantId)))) {
    await update(v, { active: false }, "hidden");
  }
  return changed;
}

/** Products checked at the same time by a full sync (one at a time took minutes on the live server). */
const SYNC_CONCURRENCY = 8;

/** Re-reads every website product (deleted ones too) and syncs it. */
export async function syncAllFromWebsite(userId = null) {
  const totals = { created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0, errors: [] };
  const products = await WebsiteProduct.find().select("-embedding").lean();
  let next = 0;
  const worker = async () => {
    while (next < products.length) {
      const web = products[next++];
      try {
        totals[await syncFromWebsite(web, userId)]++;
      } catch (e) {
        totals.failed++;
        if (totals.errors.length < 20) totals.errors.push({ websiteProductId: s(web._id), name: web.name, error: e.message });
      }
    }
  };
  await Promise.all(Array.from({ length: SYNC_CONCURRENCY }, worker));
  return totals;
}

/** Live sync: watches the website's products collection (needs a replica set, which Atlas is). */
export function startWebsiteWatcher() {
  const queues = new Map(); // product id → promise, so changes to one product run in order
  const run = (id, task) => {
    const next = (queues.get(id) ?? Promise.resolve()).then(task).catch((e) => console.error("[inventory] website sync:", e.message));
    queues.set(id, next);
    next.finally(() => queues.get(id) === next && queues.delete(id));
  };

  const start = () => {
    let stream;
    try {
      stream = WebsiteProduct.watch([], { fullDocument: "updateLookup" });
    } catch (e) {
      console.warn("[inventory] website product watcher unavailable:", e.message);
      return;
    }
    stream.on("change", (change) => {
      const id = s(change.documentKey?._id);
      if (!id) return;
      if (change.operationType === "delete") {
        run(id, () =>
          Product.updateOne({ "website.productId": id }, { status: "INACTIVE", "website.deleted": true, "website.syncedAt": new Date() })
        );
      } else if (change.fullDocument) {
        run(id, () => syncFromWebsite(change.fullDocument));
      }
    });
    stream.on("error", (e) => {
      console.warn("[inventory] website product watcher stopped, restarting in 30s:", e.message);
      stream.close().catch(() => {});
      setTimeout(start, 30_000);
    });
  };
  start();
}

/** Inventory category for a website category name (created on first use). */
async function categoryFor(name) {
  const clean = name?.trim();
  if (!clean) return null;
  const nameKey = clean.toLowerCase();
  const existing = await Category.findOne({ nameKey }).select("_id").lean();
  if (existing) return existing._id;
  try {
    const category = await Category.findOneAndUpdate(
      { nameKey },
      { $setOnInsert: { name: clean, nameKey, active: true } },
      { upsert: true, new: true }
    ).lean();
    return category._id;
  } catch (e) {
    // Two products with the same new category synced at the same moment.
    if (!isDuplicateKey(e)) throw e;
    return (await Category.findOne({ nameKey }).select("_id").lean())._id;
  }
}

/** The website's own SKU, if it is valid, not a system code and not used yet. */
async function usableSku(value) {
  const sku = value?.trim();
  if (!sku || !SKU_PATTERN.test(sku) || RESERVED_CODE.test(sku)) return undefined;
  return (await Variant.exists({ sku })) ? undefined : sku;
}
