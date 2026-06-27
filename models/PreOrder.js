import mongoose from "mongoose";

const PreOrderSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    variantId: {
      type: String,
      required: false,
    },
    variantName: {
      type: String,
      required: false,
    },
    quantity: {
      type: Number,
      required: true,
    },
    date: {
      type: Date,
      default: Date.now,
    },
    deposit: {
      type: Number,
      default: 0,
    },
    balance: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

export default mongoose.model("PreOrder", PreOrderSchema);
