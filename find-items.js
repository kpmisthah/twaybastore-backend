import mongoose from "mongoose";
import Product from "./models/Product.js";
import dotenv from "dotenv";

dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  
  const p1 = await Product.find({ name: /100 by 50/i });
  console.log("1:", p1.map(p => p.name));

  const p2 = await Product.find({ name: /vent/i });
  console.log("2:", p2.map(p => p.name));

  const p3 = await Product.find({ name: /gravity/i });
  console.log("3:", p3.map(p => p.name));

  process.exit();
}

run().catch(console.error);
