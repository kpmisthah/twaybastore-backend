import mongoose from "mongoose";
import Product from "./models/Product.js";
import dotenv from "dotenv";

dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  
  // 1. Fix the Pink Gaming desk
  const pDesk = await Product.findOne({ name: /Z-Shaped Ergonomic Gaming Desk/i });
  if (pDesk && pDesk.variants) {
     // The user accidentally mapped Pink to '...c031' which is White. 
     // We need to re-map Pink to '...bff3', and map White to '...c031'.
     const vPink = pDesk.variants.find(v => v.color.toLowerCase().includes('pink'));
     if (vPink) {
         vPink.woltId = "6a145a89c7bb301de753bff3";
     }
     const vWhite = pDesk.variants.find(v => v.color.toLowerCase().includes('white'));
     if (vWhite) {
         vWhite.woltId = "6a145a89c7bb301de753c031";
     }
     pDesk.markModified('variants');
     await pDesk.save();
  }

  // 2. Fix the Cooking Set
  const pCook = await Product.findOne({ name: /Cooking set small/i });
  if (pCook && pCook.variants) {
     const vSmall = pCook.variants.find(v => v.dimensions.toLowerCase().includes('1 to 2'));
     if (vSmall) {
         vSmall.woltId = "6a145a89c7bb301de753c021"; // The correct Wolt ID for 1 to 2 people
     }
     const vLarge = pCook.variants.find(v => v.dimensions.toLowerCase().includes('2 to 3') || v.dimensions.toLowerCase().includes('3'));
     if (vLarge) {
         vLarge.woltId = "6a145a89c7bb301de753c0c4"; // The correct Wolt ID for 3 to 4 people
     }
     pCook.markModified('variants');
     await pCook.save();
  }

  // 3. Plyo Box 20x24x30 In
  const pPlyo = await Product.findOne({ name: /Plyo Box different sizes/i });
  if (pPlyo && pPlyo.variants) {
     const vLarge = pPlyo.variants.find(v => v.dimensions.includes('20') && v.dimensions.includes('24') && !v.dimensions.includes('16'));
     if (vLarge) {
         vLarge.woltId = "6a145a89c7bb301de753bff1";
     }
     pPlyo.markModified('variants');
     await pPlyo.save();
  }

  // 4. Premium Ergonomic Gaming Chair Black 123 By 70 By 70cm
  const pChair = await Product.findOne({ name: /Premium Ergonomic Gaming Chair/i });
  if (pChair && pChair.variants) {
     const vBlack = pChair.variants.find(v => v.color.toLowerCase().includes('black'));
     if (vBlack) {
         vBlack.woltId = "6a145a89c7bb301de753c0e4";
     }
     pChair.markModified('variants');
     await pChair.save();
  }

  // 5. Outdoor Awning Door Canopy Black 120x60cm
  const pCanopy = await Product.findOne({ name: /Outdoor Awning Door Canopy/i });
  if (pCanopy && pCanopy.variants) {
     const v120 = pCanopy.variants.find(v => v.dimensions.includes('120') && v.dimensions.includes('60'));
     if (v120) {
         v120.woltId = "6a145a89c7bb301de753bfc9";
     }
     pCanopy.markModified('variants');
     await pCanopy.save();
  }

  console.log("Fixed the final 5 mismatch errors!");
  process.exit();
}

run().catch(console.error);
