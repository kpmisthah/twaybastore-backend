
// models/Order.js
import mongoose from "mongoose";

const addressSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true },
    email: { type: String, trim: true },
    phone: { type: String, trim: true },
    address: { type: String, trim: true }, // street / line1
    city: { type: String, trim: true },
    state: { type: String, trim: true }, // map your "area" here if needed
    zip: { type: String, trim: true },
    country: { type: String, trim: true }, // prefer 2-letter code if possible
  },
  { _id: false }
);

const contactSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true },
    email: { type: String, trim: true },
    phone: { type: String, trim: true },
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    // ✅ Made user optional for guest orders
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: false },

    items: [
      {
        name: String,
        price: Number,
        qty: Number,
        image: String,
        product: { type: mongoose.Schema.Types.ObjectId, ref: "Product" },
        color: String,
        dimensions: String,
      },
    ],

    total: { type: Number, required: true },
    status: {
      type: String,
      enum: ["Processing", "Packed", "Delivered", "Cancelled", "Shipped"],
      default: "Processing",
    },
    cancelReason: { type: String },

    // Persisted shipping/contact info
    shipping: addressSchema,
    contact: contactSchema,

    // Payment info
    isPaid: { type: Boolean, default: false },
    paidAt: { type: Date },
    paymentIntentId: { type: String, index: true }, // Index for faster webhook lookups
    paymentMethod: {
      type: String,
      enum: ["CARD", "COD"],
      default: "CARD"
    },
    paymentStatus: {
      type: String,
      enum: ["pending", "succeeded", "failed", "canceled", "refunded", "disputed"],
      default: "pending",
    },

    // Discount/Coupon tracking
    finalTotal: { type: Number },
    discountAmount: { type: Number, default: 0 },
    couponCode: { type: String },

    // Refund tracking
    isRefunded: { type: Boolean, default: false },
    refundId: { type: String },
    refundedAt: { type: Date },

    // Dispute tracking
    disputedAt: { type: Date },

    // Idempotency key for preventing duplicate orders
    idempotencyKey: { type: String, unique: true, sparse: true },
  },
  { timestamps: true }
);

export default mongoose.model("Order", orderSchema);