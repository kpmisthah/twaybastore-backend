// models/Coupon.js
import mongoose from "mongoose";

const CouponSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },

    // business rules
    discountType: { type: String, enum: ["percent"], default: "percent" },
    value: { type: Number, required: true }, // 5 = 5%

    // lifecycle
    createdAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true, index: true },
    usedAt: { type: Date, default: null },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null },
    reason: { type: String, default: "WELCOME_NEW_USER" },
  },
  { versionKey: false }
);

// optional TTL (MongoDB TTL requires field be a Date and index 'expireAfterSeconds: 0')
// we'll keep a standard index on expiresAt above and you can schedule a cleanup if you prefer,
// but if you want TTL auto-removal after expiry, enable this:
CouponSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model("Coupon", CouponSchema);
