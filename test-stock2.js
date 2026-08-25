import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();
import Product from "./models/Product.js";

async function test() {
  await mongoose.connect(process.env.MONGO_URI);
  const p = await Product.findOne({ "variants.0": { $exists: true } });
  if (!p) {
    console.log("no product");
    process.exit(1);
  }
  console.log("Found:", p.name, "Before:", p.variants[0].stock);
  const variantId = p.variants[0]._id.toString();
  const v = p.variants.find(v => v._id.toString() === variantId);
  if (v) {
    v.stock = v.stock - 1;
  }
  p.markModified('variants');
  await p.save();
  const p2 = await Product.findById(p._id);
  console.log("After:", p2.variants[0].stock);
  process.exit(0);
}
test();
