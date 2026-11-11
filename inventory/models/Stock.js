// inventory/models/Stock.js — only services/stock.js writes these.
import { appendOnly, model, ObjectId, Schema } from "./_base.js";

/** Current stock of one item (STANDARD or COMPONENT variant) at one location. available = onHand − reserved. */
const stockLevelSchema = new Schema(
  {
    variantId: { type: ObjectId, ref: "InvVariant", required: true },
    locationId: { type: ObjectId, ref: "InvLocation", required: true },
    onHand: { type: Number, default: 0, min: 0 },
    reserved: { type: Number, default: 0, min: 0 },
  },
  { timestamps: { createdAt: false, updatedAt: true } }
);
stockLevelSchema.index({ variantId: 1, locationId: 1 }, { unique: true });
stockLevelSchema.index({ locationId: 1 });
export const StockLevel = model("InvStockLevel", stockLevelSchema, "inv_stock_levels");

export const MOVEMENT_TYPES = [
  "STOCK_IN", // received into a location (purchase, found, …)
  "STOCK_OUT", // removed from stock (lost, expired, …)
  "TRANSFER",
  "ADJUSTMENT", // stocktake correction, in or out
  "RESERVE", // set aside for an order; stays on hand
  "RELEASE",
  "LOAD", // reserved stock loaded on a van → In Transit
  "DELIVER", // handed to the customer; leaves In Transit
  "RETURN", // back from a failed/cancelled delivery or a customer
  "SALE",
  "SALE_RETURN",
  "DAMAGE", // moved to the Damaged location
  "TRANSFER_OUT", // two-step transfer, step 1: left the source, now In Transit
  "TRANSFER_IN", // two-step transfer, step 2: scanned in at the destination
];

/** Append-only ledger. */
const movementSchema = new Schema(
  {
    type: { type: String, enum: MOVEMENT_TYPES, required: true },
    variantId: { type: ObjectId, ref: "InvVariant", required: true },
    /** Always positive; direction comes from from/to. */
    quantity: { type: Number, required: true, min: 1 },
    fromLocationId: { type: ObjectId, ref: "InvLocation", default: null },
    toLocationId: { type: ObjectId, ref: "InvLocation", default: null },
    userId: { type: ObjectId, ref: "InvUser", default: null },
    reason: { type: String, default: null },
    note: { type: String, default: null },
    /** Invoice number, order number, stocktake code… */
    reference: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
movementSchema.index({ variantId: 1, createdAt: -1 });
movementSchema.index({ fromLocationId: 1 });
movementSchema.index({ toLocationId: 1 });
movementSchema.index({ createdAt: -1 });
appendOnly(movementSchema, "The stock ledger");
export const StockMovement = model("InvStockMovement", movementSchema, "inv_stock_movements");
