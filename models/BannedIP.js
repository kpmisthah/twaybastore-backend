// models/BannedIP.js
import mongoose from "mongoose";

const bannedIPSchema = new mongoose.Schema(
  {
    ip: { type: String, required: true, unique: true },
    reason: { type: String, default: "Policy violation" },
    bannedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, default: null }, // optional
  },
  { timestamps: true }
);

export default mongoose.model("BannedIP", bannedIPSchema);
