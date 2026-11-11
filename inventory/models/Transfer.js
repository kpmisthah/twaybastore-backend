// inventory/models/Transfer.js — two-step transfers and stocktakes.
import { model, ObjectId, Schema } from "./_base.js";

export const TRANSFER_STATUSES = ["IN_TRANSIT", "RECEIVED", "CANCELLED"];

const transferLineSchema = new Schema({
  variantId: { type: ObjectId, ref: "InvVariant", required: true },
  quantity: { type: Number, required: true, min: 1 },
  received: { type: Number, default: 0 },
  /** Never arrived — written off when the transfer was closed. */
  lost: { type: Number, default: 0 },
});

/** Scan out at the source (stock goes In Transit), scan in at the destination. */
const transferSchema = new Schema(
  {
    number: { type: Number, required: true, unique: true },
    code: { type: String, required: true, unique: true },
    fromLocationId: { type: ObjectId, ref: "InvLocation", required: true },
    toLocationId: { type: ObjectId, ref: "InvLocation", required: true },
    status: { type: String, enum: TRANSFER_STATUSES, default: "IN_TRANSIT" },
    note: { type: String, default: null },
    sentById: { type: ObjectId, ref: "InvUser", required: true },
    receivedById: { type: ObjectId, ref: "InvUser", default: null },
    sentAt: { type: Date, default: Date.now },
    receivedAt: { type: Date, default: null },
    /** Why it was closed with items missing, or cancelled. */
    closedReason: { type: String, default: null },
    lines: [transferLineSchema],
    rev: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: false, updatedAt: true } }
);
transferSchema.index({ status: 1, sentAt: -1 });
export const Transfer = model("InvTransfer", transferSchema, "inv_transfers");

export const STOCKTAKE_STATUSES = ["COUNTING", "SUBMITTED", "APPROVED", "CANCELLED"];

/** Count a location, then an admin/manager approves the differences. */
const stocktakeSchema = new Schema(
  {
    number: { type: Number, required: true, unique: true },
    code: { type: String, required: true, unique: true },
    /** The location counted, including everything inside it. */
    locationId: { type: ObjectId, ref: "InvLocation", required: true },
    status: { type: String, enum: STOCKTAKE_STATUSES, default: "COUNTING" },
    note: { type: String, default: null },
    createdById: { type: ObjectId, ref: "InvUser", required: true },
    submittedById: { type: ObjectId, ref: "InvUser", default: null },
    submittedAt: { type: Date, default: null },
    approvedById: { type: ObjectId, ref: "InvUser", default: null },
    approvedAt: { type: Date, default: null },
    rev: { type: Number, default: 0 },
  },
  { timestamps: true }
);
stocktakeSchema.index({ status: 1, createdAt: -1 });
export const Stocktake = model("InvStocktake", stocktakeSchema, "inv_stocktakes");

/** Own collection: several people scan into the same stocktake at once (atomic per line). */
const stocktakeLineSchema = new Schema({
  stocktakeId: { type: ObjectId, ref: "InvStocktake", required: true },
  variantId: { type: ObjectId, ref: "InvVariant", required: true },
  /** A space (or other stock-holding location) inside the stocktake's location. */
  locationId: { type: ObjectId, ref: "InvLocation", required: true },
  /** On hand when the stocktake started. */
  expected: { type: Number, required: true },
  /** Null until counted. */
  counted: { type: Number, default: null },
  /** System on-hand at the (last) count: approval applies counted − this, so later sales aren't undone. */
  onHandAtCount: { type: Number, default: null },
  onHandAtApproval: { type: Number, default: null },
  adjustment: { type: Number, default: null },
  countedById: { type: ObjectId, ref: "InvUser", default: null },
  countedAt: { type: Date, default: null },
});
stocktakeLineSchema.index({ stocktakeId: 1, variantId: 1, locationId: 1 }, { unique: true });
export const StocktakeLine = model("InvStocktakeLine", stocktakeLineSchema, "inv_stocktake_lines");
