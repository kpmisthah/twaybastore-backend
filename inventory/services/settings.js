// inventory/services/settings.js — key/value app settings with defaults.
import Setting from "../models/Setting.js";
import { audit } from "./audit.js";

export const DEFAULT_SETTINGS = {
  businessName: "Twayba",
  currency: "EUR",
  /** True when entered prices already include VAT (normal for Malta retail). */
  pricesIncludeTax: true,
  labelWidthMm: 50,
  labelHeightMm: 25,
  /** Print the selling price on product labels. */
  labelShowPrice: false,
  /** Printed on invoices and receipts. */
  businessAddress: "",
  businessPhone: "",
  vatNumber: "",
  /** Thank-you / returns policy line at the bottom of receipts and invoices. */
  receiptFooter: "Thank you for your purchase!",
  /** Receipt printer paper width (58 or 80 mm usually). */
  receiptWidthMm: 80,
  /** Cashiers may give up to this % discount per line; more needs an admin/manager. */
  maxDiscountPercent: 10,
};

export async function getSettings(session) {
  const rows = await Setting.find().session(session ?? null).lean();
  const stored = Object.fromEntries(rows.map((r) => [r._id, r.value]));
  return { ...DEFAULT_SETTINGS, ...pickKnown(stored) };
}

export async function updateSettings(userId, changes) {
  const known = pickKnown(changes);
  await Promise.all(
    Object.entries(known).map(([key, value]) => Setting.updateOne({ _id: key }, { value }, { upsert: true }))
  );
  await audit({ userId, action: "SETTINGS_UPDATED", entity: "Setting", data: known });
  return getSettings();
}

function pickKnown(values) {
  const out = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (values[key] !== undefined) out[key] = values[key];
  }
  return out;
}
