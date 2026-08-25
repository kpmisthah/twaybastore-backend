import mongoose from "mongoose";
import Product from "./models/Product.js";
import dotenv from "dotenv";

dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  
  const pCook = await Product.findOne({ name: /Cooking set small/i });
  if (pCook) {
      if (pCook.variants && pCook.variants.length > 0) {
          // Just assign it to the first variant
          pCook.variants[0].woltId = "6a145a89c7bb301de753c0c4";
          pCook.markModified('variants');
      } else {
          pCook.woltId = "6a145a89c7bb301de753c0c4";
      }
      await pCook.save();
  }

  process.exit();
}
run().catch(console.error);
