import mongoose from "mongoose";
import Product from "./models/Product.js";
import dotenv from "dotenv";

async function countDB(envPath, envName) {
  dotenv.config({ path: envPath, override: true });
  await mongoose.disconnect();
  await mongoose.connect(process.env.MONGO_URI);
  
  const products = await Product.find({ isDeleted: { $ne: true } });
  let topLevel = products.length;
  let variants = 0;
  
  for (let p of products) {
    if (p.variants && p.variants.length > 0) {
      variants += p.variants.length;
    } else {
      variants += 1; // if no variants, it counts as 1 variant for mapping purposes
    }
  }
  
  console.log(`\n--- ${envName} Database ---`);
  console.log(`Total Base Products: ${topLevel}`);
  console.log(`Total Products (including individual variants): ${variants}`);
}

async function run() {
  await countDB(".env", "Production (Live)");
  await countDB(".env.development", "Development (Local)");
  process.exit();
}

run().catch(console.error);
