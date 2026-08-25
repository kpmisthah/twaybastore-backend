import mongoose from 'mongoose';
import Product from './models/Product.js';
import dotenv from 'dotenv';
dotenv.config();
async function r() {
  await mongoose.connect(process.env.MONGO_URI);
  const p1 = await Product.findOne({ name: /Car vent holder/i });
  console.log("Deleted:", p1.isDeleted);
  process.exit(0);
}
r();
