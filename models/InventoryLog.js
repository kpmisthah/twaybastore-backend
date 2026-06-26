// models/InventoryLog.js
import mongoose from "mongoose";

const inventoryLogSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    variantId: {
      type: String, // String representation of variant ObjectId or null if default
      default: null,
    },
    actionType: {
      type: String,
      enum: ["add_stock", "move", "sale", "adjustment"],
      required: true,
    },
    fromLocation: {
      type: String,
      enum: ["downstairs", "upstairs", "store", "mosta_garage", "naxxar_garage", null], // null if adding stock
      default: null,
    },
    toLocation: {
      type: String,
      enum: ["downstairs", "upstairs", "store", "mosta_garage", "naxxar_garage", null], // null if sale/adjustment
      default: null,
    },
    quantity: {
      type: Number,
      required: true,
    },
    channel: {
      type: String,
      enum: ["wolt", "shop", "website", null],
      default: null,
    },
    businessDate: {
      type: String, // YYYY-MM-DD
      index: true,
    },
    price: {
      type: Number, // Optional, useful for external sales
    },
    notes: {
      type: String,
    },
  },
  { timestamps: true }
);

export default mongoose.model("InventoryLog", inventoryLogSchema);
