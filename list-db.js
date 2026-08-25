import mongoose from "mongoose";
import Product from "./models/Product.js";
import dotenv from "dotenv";
dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const products = await Product.find({ isDeleted: { $ne: true } }).limit(20);
  products.forEach(p => console.log(p.name, p.variants.map(v => v.color + " " + v.dimensions)));
  process.exit();
}
run().catch(console.error);
