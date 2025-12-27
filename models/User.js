import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    /* ------------------ Basic Info ------------------ */
    fullName: { type: String, required: true },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },

    mobile: { type: String, trim: true },
    password: { type: String, required: true },

    /* ------------------ Marketing Consent ------------------ */
    sendAdsEmail: { type: Boolean, default: false },

    /* ------------------ OTP Verification ------------------ */
    otpHash: { type: String, default: null },
    otpExpiresAt: { type: Date, default: null },
    isVerified: { type: Boolean, default: false },

    /* ------------------ Ban System ------------------ */
    isBanned: { type: Boolean, default: false },
    banReason: { type: String, default: "" },
    bannedAt: { type: Date, default: null },

    /* ------------------ Additional Info ------------------ */
    secondPhone: String,
    street: String,
    city: String,
    area: String,
    zipCode: String,
  },
  { timestamps: true }
);

/* Optional middleware — automatically set bannedAt date */
userSchema.pre("save", function (next) {
  if (this.isBanned && !this.bannedAt) {
    this.bannedAt = new Date();
  } else if (!this.isBanned) {
    this.bannedAt = null;
  }
  next();
});

const User = mongoose.model("User", userSchema);
export default User;
