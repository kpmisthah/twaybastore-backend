
import mongoose from "mongoose";
import dotenv from "dotenv";
import Product from "./models/Product.js";

dotenv.config();

async function checkProducts() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log("Connected to MongoDB");

        const productNames = [
            "Laptop Desk for Bed, Adjustable Laptops Stand with 5 Adjustable Angles, Portable Lap Tray Table with Cup Holder, Laptop Bed Desk Tray for Eating Working, Gaming , Reading On Sofa/Couch/Floor - Multi-Color",
            "Professional Rubber Hex Dumbbell Pair with Ergonomic Chrome Handles , Hexagonal Rubber Coated Dumbbells - Anti-Roll Fixed Weight for Strength Training"
        ];

        for (const name of productNames) {
            const product = await Product.findOne({ name }).lean();
            if (product) {
                console.log(`Product: ${product.name}`);
                console.log(`ID: ${product._id}`);
                console.log(`Variants Count: ${product.variants?.length || 0}`);
                product.variants?.forEach((v, i) => {
                    console.log(`  Variant ${i}: Color="${v.color}", Dimensions="${v.dimensions}", Price=${v.price}`);
                });
            } else {
                console.log(`Product NOT FOUND: ${name}`);
            }
            console.log('---');
        }

        await mongoose.disconnect();
    } catch (err) {
        console.error(err);
    }
}

checkProducts();
