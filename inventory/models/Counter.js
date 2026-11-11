// inventory/models/Counter.js — named counters for generated codes (product, location, invoice numbers).
import { model, Schema } from "./_base.js";

const counterSchema = new Schema({ _id: String, value: { type: Number, default: 0 } }, { versionKey: false });

export default model("InvCounter", counterSchema, "inv_counters");
