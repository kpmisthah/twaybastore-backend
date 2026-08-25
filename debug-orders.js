
import mongoose from "mongoose";
import dotenv from "dotenv";
import Order from "./models/Order.js";

dotenv.config();

async function checkOrders() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log("Connected to MongoDB");

        const orders = await Order.find().sort({ createdAt: -1 }).limit(5).lean();

        orders.forEach(order => {
            console.log(`Order ID: ${order._id} (Status: ${order.status})`);
            order.items.forEach(item => {
                console.log(`  Item: ${item.name}`);
                console.log(`    Color: "${item.color}"`);
                console.log(`    Dimensions: "${item.dimensions}"`);
            });
            console.log('---');
        });

        await mongoose.disconnect();
    } catch (err) {
        console.error(err);
    }
}

checkOrders();
