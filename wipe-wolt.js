import mongoose from "mongoose";
import Product from "./models/Product.js";
import dotenv from "dotenv";
dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const products = await Product.find({});
  for (let prod of products) {
    prod.woltId = undefined;
    if (prod.variants) {
      for (let v of prod.variants) {
        v.woltId = undefined;
      }
    }
    await prod.save();
  }
  console.log("Wiped all Wolt IDs from production DB.");
  
  // also wipe dev DB if it exists
  dotenv.config({ path: ".env.development", override: true });
  await mongoose.disconnect();
  await mongoose.connect(process.env.MONGO_URI);
  const devProducts = await Product.find({});
  for (let prod of devProducts) {
    prod.woltId = undefined;
    if (prod.variants) {
      for (let v of prod.variants) {
        v.woltId = undefined;
      }
    }
    await prod.save();
  }
  console.log("Wiped all Wolt IDs from dev DB.");

  process.exit();
}
run().catch(console.error);
