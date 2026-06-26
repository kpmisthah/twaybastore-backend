import mongoose from "mongoose";

const storeInventorySchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    // Variant identifier — use variant color/name, or "default" for products without variants
    variant: {
      type: String,
      default: "default",
    },
    // Optional: store the variant ObjectId for direct reference
    variantId: {
      type: String,
      default: null,
    },
    // Quantities at each physical storage location
    locations: {
      downstairs: { type: Number, default: 0, min: 0 },
      upstairs: { type: Number, default: 0, min: 0 },
      store: { type: Number, default: 0, min: 0 },
      mosta_garage: { type: Number, default: 0, min: 0 },
      naxxar_garage: { type: Number, default: 0, min: 0 },
    },
  },
  { timestamps: true }
);

// Compound index: one record per product+variant combination
storeInventorySchema.index({ product: 1, variant: 1 }, { unique: true });

const StoreInventory = mongoose.model("StoreInventory", storeInventorySchema);
export default StoreInventory;
