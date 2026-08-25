import mongoose from "mongoose";
import Product from "./models/Product.js";
import dotenv from "dotenv";
dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const products = await Product.find({});
  let count = 0;
  for (let p of products) {
    if (p.woltId) count++;
    if (p.variants) count += p.variants.filter(v => v.woltId).length;
  }
  console.log("Total Wolt IDs:", count);
  process.exit();
}
run().catch(console.error);
