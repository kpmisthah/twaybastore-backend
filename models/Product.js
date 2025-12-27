import mongoose from "mongoose";

// ---------------- Variant Schema ----------------
const variantSchema = new mongoose.Schema({
  color: { type: String, required: true },

  // FIXED: dimensions must NOT be required because old products don't have it
  dimensions: { type: String, required: false },

  stock: { type: Number, default: 0 },
  realPrice: { type: Number, required: false },
  price: { type: Number, required: true },
  discount: { type: Number, default: 0 },
  images: [String],
});

// ---------------- Product Schema ----------------
const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    description: { type: String, required: true },

    realPrice: { type: Number },
    price: { type: Number, required: true },
    discount: { type: Number, default: 0 },

    sku: { type: String },
    category: { type: String, required: true },
    brand: { type: String },

    isDiscounted: { type: Boolean, default: false },
    limitedTimeDeal: { type: Boolean, default: false },
    weeklyDeal: { type: Boolean, default: false },
    blackFridayOffer: { type: Boolean, default: false },

    images: [String],

    weight: { type: String },
    dimensions: { type: String }, // product-level
    warranty: { type: String },
    countryOfOrigin: { type: String, default: "Malta" },

    variants: [variantSchema],
    otherDetails: mongoose.Schema.Types.Mixed,

    clickCount: { type: Number, default: 0 },

    // AI Embeddings field — local MiniLM vector
    embedding: {
      type: [Number],
      default: [],
      index: false,
    },

    // Soft Delete fields
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

const Product = mongoose.model("Product", productSchema);
export default Product;
