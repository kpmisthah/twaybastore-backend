import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();
import Product from "./models/Product.js";

async function test() {
  await mongoose.connect(process.env.MONGO_URI);
  const product = await Product.findOne({ name: "fabrics" });
  console.log("Top level stock:", product.stock);
  process.exit(0);
}
test();
