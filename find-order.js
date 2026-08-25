
import mongoose from "mongoose";
import dotenv from "dotenv";
import Order from "./models/Order.js";

dotenv.config();

async function findOrder() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log("Connected to MongoDB");

        const orders = await Order.find().lean();
        const target = orders.find(o => o._id.toString().endsWith("aa441e"));

        if (target) {
            console.log(JSON.stringify(target, null, 2));
        } else {
            console.log("Order aa441e NOT FOUND");
        }

        await mongoose.disconnect();
    } catch (err) {
        console.error(err);
    }
}

findOrder();
