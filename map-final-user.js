import mongoose from "mongoose";
import Product from "./models/Product.js";
import dotenv from "dotenv";

dotenv.config();

const mappings = [
  { id: "6a145a89c7bb301de753c0f0", nameMatch: /Professional Rubber Hex Dumbbell Pair/i, colorMatch: /Black/i, dimMatch: /2.5 kg/i },
  { id: "6a145a89c7bb301de753c09f", nameMatch: /Fitness rope , Battle rope/i, colorMatch: /Black/i, dimMatch: /38mm - 9mm/i },
  { id: "6a145a89c7bb301de753c034", nameMatch: /Plyo Box different sizes/i, colorMatch: /Brown/i, dimMatch: /16 by 20 by 24/i },
  { id: "6a145a89c7bb301de753c031", nameMatch: /Z-Shaped Ergonomic Gaming Desk/i, colorMatch: /Pink/i, dimMatch: /1m x 60 cm/i },
  { id: "6a145a89c7bb301de753bf7d", nameMatch: /Folding Black Chair/i, colorMatch: /Black/i, dimMatch: /46 by 47 by 79cm/i },
  { id: "6a145a89c7bb301de753c041", nameMatch: /Outdoor Awning Door Canopy Shelter/i, colorMatch: /Black/i, dimMatch: /120 by 80cm/i },
  { id: "6a145a89c7bb301de753bf7c", nameMatch: /Ocean Pack Waterproof Dry Bag/i, colorMatch: /30L/i, dimMatch: /Water proof/i },
  { id: "6a145a89c7bb301de753c108", nameMatch: /Ocean Pack Waterproof Dry Bag/i, colorMatch: /20L/i, dimMatch: /Water proof/i },
  { id: "6a145a89c7bb301de753c083", nameMatch: /Ocean Pack Waterproof Dry Bag/i, colorMatch: /15L/i, dimMatch: /Water proof/i },
  { id: "6a145a89c7bb301de753c0b6", nameMatch: /Ocean Pack Waterproof Dry Bag/i, colorMatch: /10L/i, dimMatch: /Water proof/i },
  { id: "6a145a89c7bb301de753c0dc", nameMatch: /Ocean Pack Waterproof Dry Bag/i, colorMatch: /5L/i, dimMatch: /Water proof/i },
  { id: "6a145a89c7bb301de753c0c4", nameMatch: /Cooking set small , Camping cooking set/i, colorMatch: /Black/i, dimMatch: /suitable for 1 to 2 people/i }
];

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  let mapped = 0;

  for (let map of mappings) {
    const products = await Product.find({ name: map.nameMatch, isDeleted: { $ne: true } });
    if (products.length > 0) {
      let prod = products[0];
      if (prod.variants && prod.variants.length > 0) {
        let found = false;
        for (let v of prod.variants) {
          if ((map.colorMatch.test(v.color) && map.dimMatch.test(v.dimensions)) || 
              (map.dimMatch.test(v.color) && map.colorMatch.test(v.dimensions))) {
            v.woltId = map.id;
            found = true;
            break;
          }
        }
        if (found) {
           prod.markModified('variants');
           await prod.save();
           mapped++;
           console.log(`Mapped ${map.id} to variant in ${prod.name}`);
        } else {
           // Fallback to assign to first unmapped variant if regex misses due to slight variations
           const unmappedVar = prod.variants.find(v => !v.woltId);
           if (unmappedVar) {
              unmappedVar.woltId = map.id;
              prod.markModified('variants');
              await prod.save();
              mapped++;
              console.log(`Fallback mapped ${map.id} to variant in ${prod.name}`);
           }
        }
      } else {
         prod.woltId = map.id;
         prod.markModified('woltId');
         await prod.save();
         mapped++;
         console.log(`Mapped ${map.id} to root ${prod.name}`);
      }
    } else {
      console.log(`Could not find product for ${map.nameMatch}`);
    }
  }

  console.log(`Successfully mapped ${mapped} items!`);
  process.exit();
}

run().catch(console.error);
