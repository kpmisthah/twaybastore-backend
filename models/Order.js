
// models/Order.js
import mongoose from "mongoose";

const addressSchema = new mongoose.Schema(
  {
    name:   { type: String, trim: true },
    email:  { type: String, trim: true },
    phone:  { type: String, trim: true },
    address:{ type: String, trim: true }, // street / line1
    city:   { type: String, trim: true },
    state:  { type: String, trim: true }, // map your "area" here if needed
    zip:    { type: String, trim: true },
    country:{ type: String, trim: true }, // prefer 2-letter code if possible
  },
  { _id: false }
);

const contactSchema = new mongoose.Schema(
  {
    name:  { type: String, trim: true },
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
    paymentIntentId: { type: String },
    isRefunded: { type: Boolean, default: false },
    refundId: { type: String },
  },
  { timestamps: true }
);

export default mongoose.model("Order", orderSchema);