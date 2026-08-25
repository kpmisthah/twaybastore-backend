import mongoose from "mongoose";
import Product from "./models/Product.js";
import dotenv from "dotenv";

dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  
  const mappings = [
    { woltId: "6a145a89c7bb301de753bff4", dbNameMatch: /Phone Mount for Car Cell Phone/i },
    { woltId: "6a145a89c7bb301de753c009", dbNameMatch: /^Car vent holder/i },
    { woltId: "6a145a89c7bb301de753c0c8", dbNameMatch: /Universal Gravity Auto-Lock Car Phone Holder/i }
  ];

  for (let map of mappings) {
    const prod = await Product.findOne({ name: map.dbNameMatch });
    if (prod) {
      if (prod.variants && prod.variants.length > 0) {
         prod.variants[0].woltId = map.woltId;
         prod.markModified('variants');
      } else {
         prod.woltId = map.woltId;
         prod.markModified('woltId');
      }
      await prod.save();
      console.log(`Mapped ${map.woltId} to ${prod.name}`);
    } else {
      console.log(`Could not find ${map.dbNameMatch}`);
    }
  }

  process.exit();
}

run().catch(console.error);
