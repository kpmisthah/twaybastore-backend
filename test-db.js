import mongoose from "mongoose";
import Product from "./models/Product.js";
import dotenv from "dotenv";

dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  
  const p1 = await Product.findOne({ name: /Car vent holder/i });
  console.log("p1:", p1.name, "woltId:", p1.woltId, "variants:", p1.variants);

  const p2 = await Product.findOne({ name: /Universal Gravity/i });
  console.log("p2:", p2.name, "woltId:", p2.woltId, "variants:", p2.variants);

  process.exit();
}
run().catch(console.error);
