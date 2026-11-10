// inventory/lib/refs.js — small lookups shared by transfers, stocktakes, sales and orders.
import { notFound } from "./http.js";
import { Variant } from "../models/Catalog.js";
import User from "../models/User.js";

const s = (v) => (v == null ? v : String(v));

/** Money for the API: "12.50" (the frontend's Money type is a string, as Prisma Decimals were). */
export const m2 = (v) => (v === null || v === undefined ? null : (Math.round(Number(v) * 100) / 100).toFixed(2));

/** id → { id, kind, code, name, product: { id, name, images } } */
export async function variantRefs(ids, session) {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  if (!unique.length) return new Map();
  const rows = await Variant.find({ _id: { $in: unique } })
    .select("kind code name productId")
    .populate("productId", "name images")
    .session(session ?? null)
    .lean();
  return new Map(
    rows.map((v) => [
      s(v._id),
      {
        id: s(v._id),
        kind: v.kind,
        code: v.code,
        name: v.name,
        product: { id: s(v.productId?._id), name: v.productId?.name ?? "?", images: v.productId?.images ?? [] },
      },
    ])
  );
}

/** id → { id, name } */
export async function userRefs(ids) {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  if (!unique.length) return new Map();
  const rows = await User.find({ _id: { $in: unique } }).select("name").lean();
  return new Map(rows.map((u) => [s(u._id), { id: s(u._id), name: u.name }]));
}

/** "Chair – Red (TW-000012-1)" style name for messages. */
export function itemName(ref) {
  if (!ref) return "item";
  return ref.name === "Default" ? ref.product.name : `${ref.product.name} – ${ref.name}`;
}

/**
 * Takes the document's write lock for the rest of the transaction (Postgres' SELECT … FOR UPDATE):
 * any other transaction that touches it conflicts and is retried from a fresh read.
 * The schema must declare `rev: Number`.
 */
export async function lockDoc(Model, id, session, label = "Record") {
  const doc = await Model.findOneAndUpdate({ _id: id }, { $inc: { rev: 1 } }, { new: true, session }).lean();
  if (!doc) throw notFound(`${label} not found`);
  return doc;
}
