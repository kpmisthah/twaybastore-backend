import mongoose from "mongoose";
import Product from "./models/Product.js";
import dotenv from "dotenv";

dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const products = await Product.find({ name: /sucker and clamp/i });
  for (let p of products) {
    if (p.variants) {
      for (let v of p.variants) {
        console.log(`Variant ${v.color} ${v.dimensions} -> Wolt ID: ${v.woltId}`);
      }
    } else {
      console.log(`Product -> Wolt ID: ${p.woltId}`);
    }
  }
  process.exit();
}

run().catch(console.error);
