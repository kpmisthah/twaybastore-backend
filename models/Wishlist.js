// models/Wishlist.js
import mongoose from "mongoose";

const wishlistItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    color: { type: String, default: null },
    dimensions: { type: String, default: null },
    addedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const wishlistSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", unique: true, required: true },
    items: [wishlistItemSchema],
  },
  { timestamps: true }
);

export default mongoose.model("Wishlist", wishlistSchema);
