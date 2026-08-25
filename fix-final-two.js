import mongoose from "mongoose";
import Product from "./models/Product.js";
import dotenv from "dotenv";

dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  
  // Z-shaped Gaming Desk White 1 M By 60cm
  const pDesk = await Product.findOne({ name: /Z-Shaped Ergonomic Gaming Desk/i });
  if (pDesk) {
     if (pDesk.variants) {
         let vWhite = pDesk.variants.find(v => v.color.toLowerCase().includes('white'));
         if(!vWhite) {
             vWhite = pDesk.variants.find(v => !v.woltId);
         }
         if (vWhite) {
             vWhite.woltId = "6a145a89c7bb301de753c031";
             pDesk.markModified('variants');
             await pDesk.save();
         }
     }
  }

  // Camping Cooking Set Black 3 To 4 People
  const pCook = await Product.findOne({ name: /Cooking set small/i });
  if (pCook) {
     if (pCook.variants) {
         let vLarge = pCook.variants.find(v => !v.woltId);
         if (vLarge) {
             vLarge.woltId = "6a145a89c7bb301de753c0c4";
             pCook.markModified('variants');
             await pCook.save();
         }
     }
  }

  process.exit();
}

run().catch(console.error);
