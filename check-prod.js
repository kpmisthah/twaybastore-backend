
import mongoose from "mongoose";
import Product from "./models/Product.js";
import dotenv from "dotenv";

dotenv.config({ path: ".env.development" });

const checkProduct = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/ecommerce");
        const prod = await Product.findOne({ productCode: "PROD-96" });
        console.log("Product Found:", prod?.name);
        console.log("Offer Expiry:", prod?.offerExpiry);
        console.log("Weekly Deal:", prod?.weeklyDeal);
        await mongoose.disconnect();
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
};

checkProduct();
