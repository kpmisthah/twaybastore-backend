import mongoose from "mongoose";
import dotenv from "dotenv";
import StoreInventory from "./models/StoreInventory.js";
import Product from "./models/Product.js";

dotenv.config();

const syncStock = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("Connected to DB.");

    const inventories = await StoreInventory.find();
    console.log(`Found ${inventories.length} inventory records.`);

    let updatedProducts = 0;

    for (const inv of inventories) {
      const totalLocStock = 
        (inv.locations.downstairs || 0) + 
        (inv.locations.upstairs || 0) + 
        (inv.locations.store || 0) + 
        (inv.locations.mosta_garage || 0) +
        (inv.locations.naxxar_garage || 0);

      const product = await Product.findById(inv.product);
      if (!product) continue;

      let changed = false;

      if (inv.variantId) {
        const variant = product.variants.find(v => v._id.toString() === inv.variantId.toString());
        if (variant) {
          if (variant.stock !== totalLocStock) {
            variant.stock = totalLocStock;
            changed = true;
          }
        }
      } else {
        if (product.stock !== totalLocStock) {
          product.stock = totalLocStock;
          changed = true;
        }
      }

      if (changed) {
        await product.save();
        updatedProducts++;
      }
    }

    console.log(`Successfully synced stock for ${updatedProducts} products/variants.`);
    process.exit(0);
  } catch (error) {
    console.error("Error syncing stock:", error);
    process.exit(1);
  }
};

syncStock();
