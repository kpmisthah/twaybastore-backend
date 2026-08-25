import mongoose from "mongoose";
import Product from "./models/Product.js";
import dotenv from "dotenv";
dotenv.config();

const woltData = [
  {"id": "6a145a89c7bb301de753c0bd", "name": "Car Phone Holder Black 35x83mm"},
  {"id": "6a145a89c7bb301de753c0b0", "name": "7-inch Android Car Radio Tablet Black 10.5x18x5c"},
  {"id": "6a145a89c7bb301de753bff4", "name": "Car Phone Mount Black 100x50x95mm"},
  {"id": "6a145a89c7bb301de753c012", "name": "Professional Automotive Circuit Tester & Fuse Kit"},
  {"id": "6a145a89c7bb301de753c0d5", "name": "Car Roof Rack Black 1.8m"},
  {"id": "6a145a89c7bb301de753bfb9", "name": "Car Roof Rack Black 1.3m"},
  {"id": "6a145a89c7bb301de753c118", "name": "Car Roof Rack White 1.3m"},
  {"id": "6a145a89c7bb301de753c091", "name": "Car Roof Rack White 1.8m"},
  {"id": "6a145a89c7bb301de753c009", "name": "Car Vent Holder Black 5cm"},
  {"id": "6a145a89c7bb301de753c0c8", "name": "Universal Gravity Auto-lock Car Phone Holder"},
  {"id": "6a145a89c7bb301de753c06f", "name": "Double Din Android Car Multimedia Player"},
  {"id": "6a145a89c7bb301de753c063", "name": "Portable Car Power Inverter"},
  {"id": "6a145a89c7bb301de753c0fd", "name": "Car Jump Leads Red 2000 Amp"}
];

mongoose.connect(process.env.MONGO_URI).then(async () => {
  let updatedCount = 0;
  for (const item of woltData) {
    const p = await Product.findOne({ name: { $regex: new RegExp(item.name.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'i') } });
    if (p) {
      p.woltId = item.id;
      await p.save();
      updatedCount++;
    }
  }
  console.log(`Updated ${updatedCount} products with Wolt IDs`);
  process.exit();
}).catch(console.error);
