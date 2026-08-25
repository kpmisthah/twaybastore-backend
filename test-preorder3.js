import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();
import Product from "./models/Product.js";

async function test() {
  await mongoose.connect(process.env.MONGO_URI);
  const product = await Product.findOne({ name: "fabrics" });
  
  const variantId = product.variants[0]._id.toString();
  const v = product.variants.find(v => v._id.toString() === variantId);
  console.log("variant match:", v != null, v.stock);
  
  let qtyToDecrease = 1;
  v.stock = Math.max(0, v.stock - qtyToDecrease);
  
  console.log("Updated v.stock:", v.stock);
  product.markModified("variants");
  await product.save();
  
  const p2 = await Product.findById(product._id);
  console.log("Reloaded v.stock:", p2.variants[0].stock);
  process.exit(0);
}
test();
