import mongoose from "mongoose";
import Product from "./models/Product.js";
import dotenv from "dotenv";

dotenv.config();

const mappings = [
  { id: "6a145a89c7bb301de753c009", name: /Car vent holder/i, filter: v => true },
  { id: "6a145a89c7bb301de753c0c8", name: /Universal Gravity Auto-Lock Car Phone Holder/i, filter: v => true },
  { id: "6a145a89c7bb301de753c0f0", name: /Hexagonal Rubber Coated Dumbbells/i, filter: v => String(v.dimensions).includes("2.5") },
  { id: "6a145a89c7bb301de753c03a", name: /EPDM Premium Rubber Gym Flooring Tiles/i, filter: v => String(v.color).toLowerCase().includes("all black") },
  { id: "6a145a89c7bb301de753c109", name: /EPDM Premium Rubber Gym Flooring Tiles/i, filter: v => String(v.color).toLowerCase().includes("vibrant") },
  { id: "6a145a89c7bb301de753bfe5", name: /Professional Heavy Punching Boxing Bag/i, filter: v => String(v.dimensions).includes("160") },
  { id: "6a145a89c7bb301de753bfe1", name: /Stepper to Exercise at Home/i, filter: v => true },
  { id: "6a145a89c7bb301de753bfb2", name: /Resistance Tension Band/i, filter: v => String(v.color).toLowerCase().includes("blue") && String(v.dimensions).includes("64") },
  { id: "6a145a89c7bb301de753c016", name: /Resistance Tension Band/i, filter: v => String(v.color).toLowerCase().includes("green") && String(v.dimensions).includes("45") },
  { id: "6a145a89c7bb301de753c11f", name: /Resistance Tension Band/i, filter: v => String(v.color).toLowerCase().includes("green") && String(v.dimensions).includes("32") },
  { id: "6a145a89c7bb301de753c0ac", name: /Resistance Tension Band/i, filter: v => String(v.color).toLowerCase().includes("blue") && String(v.dimensions).includes("45") },
  { id: "6a145a89c7bb301de753c09f", name: /Battle rope/i, filter: v => true },
  { id: "6a145a89c7bb301de753bfdd", name: /Plyo Box different sizes/i, filter: v => String(v.dimensions).includes("16 by 18") },
  { id: "6a145a89c7bb301de753bff1", name: /Plyo Box different sizes/i, filter: v => String(v.dimensions).includes("20 by 24") },
  { id: "6a145a89c7bb301de753c034", name: /Plyo Box different sizes/i, filter: v => String(v.dimensions).includes("16 by 20") },
  { id: "6a145a89c7bb301de753c01f", name: /HD Wireless WiFi PTZ/i, filter: v => true },
  { id: "6a145a89c7bb301de753c11d", name: /Z-Shaped Ergonomic Gaming Desk/i, filter: v => String(v.color).toLowerCase().includes("black") && String(v.dimensions).includes("1m") },
  { id: "6a145a89c7bb301de753c031", name: /Z-Shaped Ergonomic Gaming Desk/i, filter: v => String(v.color).toLowerCase().includes("white") },
  { id: "6a145a89c7bb301de753c08a", name: /Black Foldable Telescoping Stool/i, filter: v => String(v.color).toLowerCase().includes("black") },
  
  // adding remaining ones based on visual patterns:
  { id: "6a145a89c7bb301de753bf7d", name: /Folding Chair/i, filter: v => String(v.color).toLowerCase() === "black" && String(v.dimensions).includes("46") },
  { id: "6a145a89c7bb301de753c04e", name: /Plastic Folding Chair/i, filter: v => String(v.color).toLowerCase().includes("white") },
  { id: "6a145a89c7bb301de753c042", name: /Outdoor Awning Door Canopy Shelter/i, filter: v => String(v.dimensions).includes("240 by 60") },
  { id: "6a145a89c7bb301de753c0e3", name: /Outdoor Awning Door Canopy Shelter/i, filter: v => String(v.dimensions).includes("240 by 80") },
  { id: "6a145a89c7bb301de753c041", name: /Outdoor Awning Door Canopy Shelter/i, filter: v => String(v.dimensions).includes("120 by 80") },
  
  { id: "6a145a89c7bb301de753bf7c", name: /Waterproof Dry Bag/i, filter: v => String(v.dimensions).includes("30L") },
  { id: "6a145a89c7bb301de753c108", name: /Waterproof Dry Bag/i, filter: v => String(v.dimensions).includes("20L") },
  { id: "6a145a89c7bb301de753c083", name: /Waterproof Dry Bag/i, filter: v => String(v.dimensions).includes("15L") },
  { id: "6a145a89c7bb301de753c0b6", name: /Waterproof Dry Bag/i, filter: v => String(v.dimensions).includes("10L") },
  { id: "6a145a89c7bb301de753c0dc", name: /Waterproof Dry Bag/i, filter: v => String(v.dimensions).includes("5L") },
  
  { id: "6a145a89c7bb301de753c0c4", name: /Camping Cookware Set Aluminum/i, filter: v => true },
  
  { id: "6a145a89c7bb301de753bfa6", name: /Outdoor Pop Up Shower Tent/i, filter: v => String(v.color).toLowerCase().includes("green") },
  { id: "6a145a89c7bb301de753c006", name: /Outdoor Pop Up Shower Tent/i, filter: v => String(v.color).toLowerCase().includes("orange") },
  { id: "6a145a89c7bb301de753bfb7", name: /Outdoor Pop Up Shower Tent/i, filter: v => String(v.color).toLowerCase().includes("camo") },
  
  { id: "6a145a89c7bb301de753c01d", name: /Bed Lock Sheet Holders/i, filter: v => true }, // they have two sizes maybe, but wolt just says white 18x12cm
  { id: "6a145a89c7bb301de753c088", name: /Heavy-Duty Industrial Storage Rack/i, filter: v => String(v.color).toLowerCase().includes("blue") },
  { id: "6a145a89c7bb301de753c0e6", name: /Heavy-Duty Industrial Storage Rack/i, filter: v => String(v.color).toLowerCase().includes("white") }
];

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  let mapped = 0;

  for (let map of mappings) {
    const products = await Product.find({ name: map.name, isDeleted: { $ne: true } });
    if (products.length > 0) {
      let prod = products[0]; // just take first
      if (prod.variants && prod.variants.length > 0) {
        let found = false;
        for (let v of prod.variants) {
          if (!v.woltId && map.filter(v)) {
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
           console.log(`Variant filter failed for ${map.id} in ${prod.name}`);
        }
      } else {
         if (!prod.woltId) {
            prod.woltId = map.id;
            prod.markModified('woltId');
            await prod.save();
            mapped++;
            console.log(`Mapped ${map.id} to root ${prod.name}`);
         }
      }
    } else {
      console.log(`Could not find product for ${map.name}`);
    }
  }

  console.log(`\nSuccessfully hard-mapped ${mapped} items!`);
  process.exit();
}

run().catch(console.error);
