
import mongoose from "mongoose";
import Product from "./models/Product.js";
import dotenv from "dotenv";

dotenv.config({ path: ".env.development" });

const checkProduct = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/ecommerce");
        const prods = await Product.find({}, "name");
        console.log("All Products:", prods.map(p => p.name));
        await mongoose.disconnect();
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
};

checkProduct();
