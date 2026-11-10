// inventory/services/stockQuery.js — read-only stock views. Stock is never written here (see stock.js).
import { notFound } from "../lib/http.js";
import { Product, Variant } from "../models/Catalog.js";
import Location from "../models/Location.js";
import { StockLevel, StockMovement } from "../models/Stock.js";
import { withDescendants } from "./locationTree.js";
import { withPaths } from "./locations.js";
import { kitAvailability } from "./movementRules.js";

const s = (v) => (v == null ? v : String(v));
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
const byPath = (a, b) => collator.compare(a.path, b.path);
const SYSTEM = ["TRANSIT", "DAMAGED"];

/**
 * Stock of every box / variant of a product.
 * "In store" counts real locations only; In Transit and Damaged are shown separately.
 */
export async function productStock(productId) {
  const product = await Product.findById(productId).select("type minStock").lean();
  if (!product) throw notFound("Product not found");
  const variants = await Variant.find({ productId })
    .select("kind code name active components sortOrder createdAt")
    .sort({ sortOrder: 1, createdAt: 1 })
    .lean();

  const levels = await StockLevel.find({
    variantId: { $in: variants.map((v) => v._id) },
    $or: [{ onHand: { $gt: 0 } }, { reserved: { $gt: 0 } }],
  }).lean();
  const paths = new Map((await withPaths()).map((l) => [l.id, l]));

  const items = variants
    .filter((v) => v.kind !== "KIT")
    .map((v) => {
      const totals = { onHand: 0, reserved: 0, available: 0, inTransit: 0, damaged: 0 };
      const rows = levels
        .filter((l) => s(l.variantId) === s(v._id))
        .map((l) => {
          const loc = paths.get(s(l.locationId));
          if (loc.type === "TRANSIT") totals.inTransit += l.onHand;
          else if (loc.type === "DAMAGED") totals.damaged += l.onHand;
          else {
            totals.onHand += l.onHand;
            totals.reserved += l.reserved;
          }
          return {
            locationId: s(l.locationId),
            path: loc.path,
            site: loc.pathNames[0],
            type: loc.type,
            onHand: l.onHand,
            reserved: l.reserved,
            available: l.onHand - l.reserved,
          };
        })
        .sort(byPath);
      totals.available = totals.onHand - totals.reserved;
      return {
        variantId: s(v._id),
        kind: v.kind,
        code: v.code,
        name: v.name,
        active: v.active,
        totals,
        low: v.kind === "STANDARD" && product.minStock > 0 && totals.available < product.minStock,
        locations: rows,
      };
    });

  // A product may have several kits (one per colour, say) — each counts complete kits from its own boxes.
  const kits = variants
    .filter((v) => v.kind === "KIT")
    .map((kitVariant) => {
      const availability = kitAvailability(
        (kitVariant.components ?? []).map((c) => ({
          variantId: s(c.componentVariantId),
          perKit: c.quantity,
          available: items.find((i) => i.variantId === s(c.componentVariantId))?.totals.available ?? 0,
        }))
      );
      return {
        variantId: s(kitVariant._id),
        code: kitVariant.code,
        name: kitVariant.name,
        ...availability,
        low: product.minStock > 0 && availability.sellable < product.minStock,
      };
    });

  return { productId: s(product._id), minStock: product.minStock, items, kit: kits[0] ?? null, kits };
}

/**
 * Items below their product's minimum stock (available in real locations). A kit counts in
 * complete kits; a normal product is checked per variant.
 */
export async function lowStock() {
  const products = await Product.find({ minStock: { $gt: 0 }, status: "ACTIVE" }).select("name images minStock").lean();
  const variants = await Variant.find({ productId: { $in: products.map((p) => p._id) }, active: true })
    .select("productId kind code name components")
    .lean();
  const realLocations = await Location.find({ type: { $nin: SYSTEM } }).distinct("_id");
  const levels = await StockLevel.find({
    variantId: { $in: variants.map((v) => v._id) },
    locationId: { $in: realLocations },
  })
    .select("variantId onHand reserved")
    .lean();
  const available = new Map();
  for (const l of levels) available.set(s(l.variantId), (available.get(s(l.variantId)) ?? 0) + l.onHand - l.reserved);

  const rows = [];
  for (const p of products) {
    const own = variants.filter((v) => s(v.productId) === s(p._id));
    for (const v of own) {
      if (v.kind === "KIT") {
        const { sellable } = kitAvailability(
          (v.components ?? []).map((c) => ({
            variantId: s(c.componentVariantId),
            perKit: c.quantity,
            available: available.get(s(c.componentVariantId)) ?? 0,
          }))
        );
        if (sellable < p.minStock) {
          const label = v.name === "Complete kit" ? p.name : `${p.name} – ${v.name}`;
          rows.push({ productId: s(p._id), name: `${label} (complete kits)`, image: p.images[0], variantId: s(v._id), code: v.code, available: sellable, minStock: p.minStock });
        }
      } else if (v.kind === "STANDARD") {
        const n = available.get(s(v._id)) ?? 0;
        if (n < p.minStock) {
          rows.push({ productId: s(p._id), name: v.name === "Default" ? p.name : `${p.name} – ${v.name}`, image: p.images[0], variantId: s(v._id), code: v.code, available: n, minStock: p.minStock });
        }
      }
    }
  }
  // Emptiest first.
  return rows.sort((a, b) => a.available / a.minStock - b.available / b.minStock || collator.compare(a.name, b.name));
}

/** Everything stored in a location and the locations inside it (e.g. a whole shelf). */
export async function locationStock(locationId) {
  const all = await withPaths();
  const location = all.find((l) => l.id === locationId);
  if (!location) throw notFound("Location not found");
  const scope = withDescendants(all, [locationId]);
  const byId = new Map(scope.map((l) => [l.id, l]));

  const levels = await StockLevel.find({
    locationId: { $in: scope.map((l) => l.id) },
    $or: [{ onHand: { $gt: 0 } }, { reserved: { $gt: 0 } }],
  }).lean();
  const variants = await Variant.find({ _id: { $in: levels.map((l) => l.variantId) } })
    .select("kind code name productId")
    .populate("productId", "name images")
    .lean();
  const variantById = new Map(variants.map((v) => [s(v._id), v]));

  const items = levels
    .map((l) => {
      const v = variantById.get(s(l.variantId));
      return {
        locationId: s(l.locationId),
        path: byId.get(s(l.locationId)).path,
        variant: {
          id: s(v._id),
          kind: v.kind,
          code: v.code,
          name: v.name,
          product: { id: s(v.productId._id), name: v.productId.name, images: v.productId.images },
        },
        onHand: l.onHand,
        reserved: l.reserved,
        available: l.onHand - l.reserved,
      };
    })
    .sort((a, b) => byPath(a, b) || collator.compare(a.variant.product.name, b.variant.product.name));

  return { location, items };
}

/** The stock ledger, newest first. */
export async function movements(query) {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 50;
  const filter = {};
  if (query.variantId) filter.variantId = query.variantId;
  if (query.productId) filter.variantId = { $in: await Variant.find({ productId: query.productId }).distinct("_id") };
  if (query.type) filter.type = query.type;
  if (query.locationId) filter.$or = [{ fromLocationId: query.locationId }, { toLocationId: query.locationId }];

  const [rows, total] = await Promise.all([
    StockMovement.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .populate({ path: "variantId", select: "code name productId", populate: { path: "productId", select: "name" } })
      .populate("userId", "name")
      .lean(),
    StockMovement.countDocuments(filter),
  ]);

  const paths = new Map((await withPaths()).map((l) => [l.id, l.path]));
  const items = rows.map(({ fromLocationId, toLocationId, variantId: v, userId: u, ...m }) => ({
    ...m,
    id: s(m._id),
    variantId: s(v?._id),
    variant: v ? { id: s(v._id), code: v.code, name: v.name, product: { id: s(v.productId?._id), name: v.productId?.name } } : null,
    userId: s(u?._id) ?? null,
    user: u ? { id: s(u._id), name: u.name } : null,
    from: fromLocationId ? { id: s(fromLocationId), path: paths.get(s(fromLocationId)) ?? "?" } : null,
    to: toLocationId ? { id: s(toLocationId), path: paths.get(s(toLocationId)) ?? "?" } : null,
  }));
  return { items, total, page, pageSize };
}
