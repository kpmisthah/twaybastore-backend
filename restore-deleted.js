import mongoose from 'mongoose';
import Product from './models/Product.js';
import dotenv from 'dotenv';
dotenv.config();
async function r() {
  await mongoose.connect(process.env.MONGO_URI);
  await Product.updateMany({ isDeleted: true }, { isDeleted: false });
  process.exit(0);
}
r();
