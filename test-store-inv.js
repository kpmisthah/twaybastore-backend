import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();
import Product from "./models/Product.js";
import StoreInventory from "./models/StoreInventory.js";

async function test() {
  await mongoose.connect(process.env.MONGO_URI);
  const p = await Product.findById("6a353e53330d94afec7c6cb9");
  if (!p) {
    console.log("No fabrics product with ID 6a353e53330d94afec7c6cb9");
    process.exit(1);
  }
  const variantId = p.variants[0]._id.toString();
  console.log("Looking for storeRec for", p._id, variantId);
  const storeRec = await StoreInventory.findOne({ product: p._id, variantId });
  console.log("storeRec found?", storeRec != null);
  process.exit(0);
}
test();
