import mongoose from 'mongoose';
import Product from './models/Product.js';
import dotenv from 'dotenv';
dotenv.config();
async function r() {
  await mongoose.connect(process.env.MONGO_URI);
  const products = await Product.find({ isDeleted: { $ne: true } });
  
  let mappedWoltIds = new Set();
  for (let prod of products) {
    if (!prod.variants || prod.variants.length === 0) {
      if (prod.woltId) mappedWoltIds.add(prod.woltId.trim());
    } else {
      for (let v of prod.variants) {
        if (v.woltId) mappedWoltIds.add(v.woltId.trim());
      }
    }
  }

  console.log('Has 6a145a89c7bb301de753c009:', mappedWoltIds.has('6a145a89c7bb301de753c009'));
  console.log('Has 6a145a89c7bb301de753c0c8:', mappedWoltIds.has('6a145a89c7bb301de753c0c8'));
  process.exit(0);
}
r();
