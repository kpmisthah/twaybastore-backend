// inventory/models/Order.js — delivery orders (manual or from the website), their stock
// allocations, delivery problems, and website orders that could not be imported.
import { model, ObjectId, Schema } from "./_base.js";

export const ORDER_SOURCES = ["MANUAL", "WEBSITE"];
export const ORDER_STATUSES = [
  "NEW", // created, nothing reserved yet
  "ALLOCATED", // stock reserved at chosen locations
  "PICKING", // some items picked/loaded
  "LOADED", // everything picked (or the rest approved as missing) — in transit
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "FAILED",
  "RETURNED",
  "CANCELLED",
];
/** COD: the driver collects codAmount. */
export const ORDER_PAYMENTS = ["PAID", "UNPAID", "COD"];
export const EXCEPTION_TYPES = ["MISSING_BOX", "DAMAGED_BOX", "CUSTOMER_REFUSED", "NOT_HOME", "WRONG_ADDRESS", "OTHER"];

/** What the customer ordered: a STANDARD variant or a whole KIT. */
const orderLineSchema = new Schema({
  lineNo: { type: Number, required: true },
  variantId: { type: ObjectId, ref: "InvVariant", required: true },
  description: { type: String, required: true },
  quantity: { type: Number, required: true, min: 1 },
  /** Price from the website, for reference. */
  unitPrice: { type: Number, default: null },
});

/** Stock reserved for a line at one location (a kit line has one or more per box). */
const allocationSchema = new Schema({
  lineId: { type: ObjectId, required: true },
  /** The STANDARD variant, or one box (COMPONENT) of a kit. */
  variantId: { type: ObjectId, ref: "InvVariant", required: true },
  locationId: { type: ObjectId, ref: "InvLocation", required: true },
  /** Reserved here. */
  quantity: { type: Number, required: true },
  /** Scanned and loaded (now In Transit). */
  picked: { type: Number, default: 0 },
  /** Reservation given back without picking (cancelled, or approved as missing). */
  released: { type: Number, default: 0 },
  /** Loaded units handed to the customer. */
  delivered: { type: Number, default: 0 },
  /** Loaded units scanned back into stock. */
  returned: { type: Number, default: 0 },
});

/** Problems reported during delivery (with photo/notes). Only ever added to. */
const exceptionSchema = new Schema(
  {
    type: { type: String, enum: EXCEPTION_TYPES, required: true },
    variantId: { type: ObjectId, ref: "InvVariant", default: null },
    /** The location responsible (e.g. where a damaged box was picked from). */
    locationId: { type: ObjectId, ref: "InvLocation", default: null },
    note: { type: String, required: true },
    photoUrl: { type: String, default: null },
    reportedById: { type: ObjectId, ref: "InvUser", required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

const orderSchema = new Schema(
  {
    number: { type: Number, required: true, unique: true },
    orderNumber: { type: String, required: true, unique: true },
    source: { type: String, enum: ORDER_SOURCES, required: true },
    /** The website's order id — the same order is never imported twice. */
    externalId: { type: String, default: null },
    status: { type: String, enum: ORDER_STATUSES, default: "NEW" },
    customerName: { type: String, required: true },
    customerPhone: { type: String, default: null },
    address: { type: String, default: null },
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    notes: { type: String, default: null },
    paymentStatus: { type: String, enum: ORDER_PAYMENTS, default: "UNPAID" },
    codAmount: { type: Number, default: null },
    /** Calendar day (YYYY-MM-DD). */
    deliveryDate: { type: String, default: null },
    /** e.g. "14:00–17:00" */
    timeWindow: { type: String, default: null },
    driverId: { type: ObjectId, ref: "InvUser", default: null },
    createdById: { type: ObjectId, ref: "InvUser", default: null },
    /** Set when an admin/manager approved finishing with boxes/items missing. */
    shortReason: { type: String, default: null },
    shortApprovedById: { type: ObjectId, ref: "InvUser", default: null },
    cancelReason: { type: String, default: null },
    startedAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    deliveredById: { type: ObjectId, ref: "InvUser", default: null },
    /** Who took the goods at the door. */
    recipientName: { type: String, default: null },
    codCollected: { type: Number, default: null },
    deliveryNote: { type: String, default: null },
    deliveryPhotoUrl: { type: String, default: null },
    partialApprovedById: { type: ObjectId, ref: "InvUser", default: null },
    failedReason: { type: String, enum: EXCEPTION_TYPES, default: null },
    lines: [orderLineSchema],
    allocations: [allocationSchema],
    exceptions: [exceptionSchema],
    rev: { type: Number, default: 0 },
  },
  { timestamps: true }
);
orderSchema.index(
  { source: 1, externalId: 1 },
  { unique: true, partialFilterExpression: { externalId: { $type: "string" } } }
);
orderSchema.index({ status: 1 });
orderSchema.index({ createdAt: -1 });
orderSchema.index({ driverId: 1, status: 1 });
export const Order = model("InvOrder", orderSchema, "inv_orders");

export const IMPORT_ISSUE_STATUSES = ["OPEN", "RESOLVED", "IGNORED"];

/**
 * A website order that could not be imported (unknown product, bad data…). Kept so nobody loses
 * an order: it is shown as a problem and can be retried once the cause is fixed.
 */
const importIssueSchema = new Schema({
  source: { type: String, enum: ORDER_SOURCES, default: "WEBSITE" },
  externalId: { type: String, default: null },
  /** Exactly what was received. */
  payload: { type: Schema.Types.Mixed, default: {} },
  error: { type: String, required: true },
  status: { type: String, enum: IMPORT_ISSUE_STATUSES, default: "OPEN" },
  attempts: { type: Number, default: 1 },
  firstSeenAt: { type: Date, default: Date.now },
  lastTriedAt: { type: Date, default: Date.now },
  orderId: { type: ObjectId, ref: "InvOrder", default: null },
  resolvedById: { type: ObjectId, ref: "InvUser", default: null },
  resolvedAt: { type: Date, default: null },
});
importIssueSchema.index(
  { source: 1, externalId: 1 },
  { unique: true, partialFilterExpression: { externalId: { $type: "string" } } }
);
importIssueSchema.index({ status: 1, lastTriedAt: -1 });
export const ImportIssue = model("InvImportIssue", importIssueSchema, "inv_import_issues");
