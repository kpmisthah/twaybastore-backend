import mongoose from "mongoose";
import Product from "./models/Product.js";
import dotenv from "dotenv";
dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const products = await Product.find({ woltId: { $exists: true, $ne: "" } });
  
  if (products.length > 0) {
    console.log("Top level products with woltId:");
    for(let i = 0; i < Math.min(3, products.length); i++) {
        console.log("Name:", products[i].name, "WoltId:", products[i].woltId);
    }
  }

  const productsWithVariants = await Product.find({ "variants.woltId": { $exists: true, $ne: "" } });
  if (productsWithVariants.length > 0) {
    console.log("\nVariants with woltId:");
    for(let i = 0; i < Math.min(3, productsWithVariants.length); i++) {
        let p = productsWithVariants[i];
        p.variants.filter(v => v.woltId).forEach(v => {
            console.log("Name:", p.name, "Color:", v.color, "WoltId:", v.woltId);
        });
    }
  }

  process.exit();
}
run().catch(console.error);
