// inventory/models/Sale.js — POS invoices and credit notes. Both are immutable (append-only):
// a return creates a credit note instead of changing the sale. Money is stored in euros, rounded to cents.
import { appendOnly, model, ObjectId, Schema } from "./_base.js";

export const PAYMENT_METHODS = ["CASH", "CARD", "BANK_TRANSFER", "OTHER"];

const pickSchema = new Schema(
  {
    variantId: { type: ObjectId, ref: "InvVariant", required: true },
    locationId: { type: ObjectId, ref: "InvLocation", required: true },
    quantity: { type: Number, required: true, min: 1 },
  },
  { _id: false }
);

/** One invoice line: a STANDARD variant or a whole KIT. Text fields are snapshots. */
const saleLineSchema = new Schema({
  lineNo: { type: Number, required: true },
  variantId: { type: ObjectId, ref: "InvVariant", required: true },
  description: { type: String, required: true },
  code: { type: String, required: true },
  quantity: { type: Number, required: true, min: 1 },
  /** As charged per unit (incl. or excl. VAT per the sale's pricesIncludeTax). */
  unitPrice: { type: Number, required: true },
  discountPercent: { type: Number, default: 0 },
  discountAmount: { type: Number, default: 0 },
  taxRateName: { type: String, default: null },
  taxRate: { type: Number, default: 0 },
  taxAmount: { type: Number, default: 0 },
  /** Line total including VAT. */
  total: { type: Number, required: true },
  /** Where the stock came from (a kit line has one per box). */
  picks: [pickSchema],
});

const paymentSchema = new Schema(
  {
    method: { type: String, enum: PAYMENT_METHODS, required: true },
    amount: { type: Number, required: true },
    /** Card slip / transfer reference. */
    reference: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

const saleSchema = new Schema(
  {
    /** Sequential, no gaps (taken from a counter inside the sale's transaction). */
    number: { type: Number, required: true, unique: true },
    invoiceNumber: { type: String, required: true, unique: true },
    /** The shop/site the sale was made at. */
    siteId: { type: ObjectId, ref: "InvLocation", default: null },
    cashierId: { type: ObjectId, ref: "InvUser", required: true },
    /** Admin/manager who approved a discount above the cashier limit. */
    approvedById: { type: ObjectId, ref: "InvUser", default: null },
    customerName: { type: String, default: null },
    customerPhone: { type: String, default: null },
    note: { type: String, default: null },
    /** Snapshot of settings at the time of sale. */
    currency: { type: String, required: true },
    pricesIncludeTax: { type: Boolean, required: true },
    grossTotal: Number,
    discountTotal: Number,
    netTotal: Number,
    taxTotal: Number,
    total: Number,
    /** Sum of payments (cash may be more than the total; the rest is change). */
    paidTotal: Number,
    changeGiven: Number,
    lines: [saleLineSchema],
    payments: [paymentSchema],
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
saleSchema.index({ createdAt: -1 });
saleSchema.index({ cashierId: 1 });
appendOnly(saleSchema, "An invoice");
export const Sale = model("InvSale", saleSchema, "inv_sales");

export const RETURN_CONDITIONS = ["GOOD", "DAMAGED"];

const creditLineSchema = new Schema({
  saleLineId: { type: ObjectId, required: true },
  quantity: { type: Number, required: true, min: 1 },
  condition: { type: String, enum: RETURN_CONDITIONS, required: true },
  /** Where the stock went back to (the Damaged location for DAMAGED). */
  locationId: { type: ObjectId, ref: "InvLocation", required: true },
  taxAmount: { type: Number, required: true },
  /** Refund for this line, including VAT. */
  total: { type: Number, required: true },
});

/** A credit note against an invoice. */
const creditNoteSchema = new Schema(
  {
    /** Sequential, no gaps (own counter, separate from invoices). */
    number: { type: Number, required: true, unique: true },
    creditNumber: { type: String, required: true, unique: true },
    saleId: { type: ObjectId, ref: "InvSale", required: true },
    cashierId: { type: ObjectId, ref: "InvUser", required: true },
    reason: { type: String, default: null },
    refundMethod: { type: String, enum: PAYMENT_METHODS, required: true },
    refundReference: { type: String, default: null },
    netTotal: Number,
    taxTotal: Number,
    total: Number,
    lines: [creditLineSchema],
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
creditNoteSchema.index({ saleId: 1 });
creditNoteSchema.index({ createdAt: -1 });
appendOnly(creditNoteSchema, "A credit note");
export const CreditNote = model("InvCreditNote", creditNoteSchema, "inv_credit_notes");
