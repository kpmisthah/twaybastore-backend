import mongoose from "mongoose";
import Product from "./models/Product.js";
import dotenv from "dotenv";
dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const products = await Product.find({ isDeleted: { $ne: true } });
  
  let woltIds = {};
  let duplicates = 0;

  for (let prod of products) {
    if (prod.woltId) {
      if (woltIds[prod.woltId]) {
        console.log("Duplicate WoltID:", prod.woltId);
        duplicates++;
      } else {
        woltIds[prod.woltId] = true;
      }
    }
    if (prod.variants) {
      for (let v of prod.variants) {
        if (v.woltId) {
          if (woltIds[v.woltId]) {
            console.log("Duplicate WoltID:", v.woltId);
            duplicates++;
          } else {
            woltIds[v.woltId] = true;
          }
        }
      }
    }
  }

  console.log("Total unique Wolt IDs mapped:", Object.keys(woltIds).length);
  console.log("Total duplicates found:", duplicates);
  process.exit();
}

run().catch(console.error);
