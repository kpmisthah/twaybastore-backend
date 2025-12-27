import mongoose from "mongoose";
const reviewSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
  user:    { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  rating:  { type: Number, required: true, min: 1, max: 5 },
  comment: { type: String },
  image:   { type: String }, // <-- Add this line for review images!
  isVerifiedBuyer: { type: Boolean, default: false }
}, { timestamps: true });
export default mongoose.model("Review", reviewSchema);