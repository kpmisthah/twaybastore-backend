// inventory/models/Setting.js — key/value settings, e.g. pricesIncludeTax, label size.
import { model, Schema } from "./_base.js";

const settingSchema = new Schema(
  { _id: String, value: Schema.Types.Mixed },
  { timestamps: { createdAt: false, updatedAt: true }, versionKey: false }
);

export default model("InvSetting", settingSchema, "inv_settings");
