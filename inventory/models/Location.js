// inventory/models/Location.js
// SITE → (FLOOR →) ROOM → SHELF → SPACE. TRANSIT and DAMAGED are system locations (one each, no parent).
import { model, ObjectId, Schema } from "./_base.js";

export const LOCATION_TYPES = ["SITE", "FLOOR", "ROOM", "SHELF", "SPACE", "TRANSIT", "DAMAGED"];

/** Never hard-deleted (stock movements refer to them); hide with `active`. */
const locationSchema = new Schema(
  {
    type: { type: String, enum: LOCATION_TYPES, required: true },
    /** Shown in paths: "Hamrun Shop", "Top", "Room 1", "Shelf A", "A1". */
    name: { type: String, required: true, trim: true },
    /** Scan code printed on the location label (LOC-000001), never changed. */
    code: { type: String, required: true, unique: true },
    parentId: { type: ObjectId, ref: "InvLocation", default: null },
    sortOrder: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);
locationSchema.index({ parentId: 1 });

export default model("InvLocation", locationSchema, "inv_locations");
