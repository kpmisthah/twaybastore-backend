import mongoose from "mongoose";
import Product from "./models/Product.js";
import dotenv from "dotenv";

dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  
  // 1. Multi-play Table Black 13 By 120 By 60cm
  const pTable = await Product.findOne({ name: /Multi-play Table/i });
  if (pTable) {
     if (pTable.variants) {
        const v = pTable.variants[0];
        if (v) v.woltId = "6a145a89c7bb301de753c023";
        pTable.markModified('variants');
     } else {
        pTable.woltId = "6a145a89c7bb301de753c023";
     }
     await pTable.save();
  }

  // 2. Z-shaped Gaming Desk White 1 M By 60cm
  const pDesk = await Product.findOne({ name: /Z-Shaped Ergonomic Gaming Desk/i });
  if (pDesk && pDesk.variants) {
     const vWhite = pDesk.variants.find(v => v.color.toLowerCase().includes('white'));
     if (vWhite) {
         vWhite.woltId = "6a145a89c7bb301de753c031";
     }
     pDesk.markModified('variants');
     await pDesk.save();
  }

  // 3. Camping Cooking Set Black 3 To 4 People
  const pCook = await Product.findOne({ name: /Cooking set small/i });
  if (pCook && pCook.variants) {
     const vLarge = pCook.variants.find(v => v.dimensions.toLowerCase().includes('2 to 3') || v.dimensions.toLowerCase().includes('3') || v.dimensions.toLowerCase().includes('4'));
     if (vLarge) {
         vLarge.woltId = "6a145a89c7bb301de753c0c4";
     }
     pCook.markModified('variants');
     await pCook.save();
  }

  process.exit();
}

run().catch(console.error);
