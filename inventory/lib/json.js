// inventory/lib/json.js
// API output shape: Mongo `_id` → `id`, ObjectIds → strings, no `__v`. Use on lean() results.
import mongoose from "mongoose";

export function toApi(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof mongoose.Types.ObjectId) return value.toString();
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(toApi);
  if (typeof value === "object") {
    if (typeof value.toObject === "function" && !(value instanceof mongoose.Types.ObjectId)) {
      value = value.toObject();
    }
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      if (key === "__v") continue;
      out[key === "_id" ? "id" : key] = toApi(v);
    }
    return out;
  }
  return value;
}

export const send = (res, data, status = 200) => res.status(status).json(toApi(data));

/** String form of an id (ObjectId, populated doc or string). */
export const sid = (v) => (v === null || v === undefined ? v : String(v._id ?? v));
