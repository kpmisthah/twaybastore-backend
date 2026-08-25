import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Order from './models/Order.js';

dotenv.config();

mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(async () => {
    // 3️⃣ Create order with proper payment flags (Simulation of orderRoutes.js)
    const order = new Order({
      items: [],
      total: 130,
      finalTotal: 130,
      discountAmount: 0,
      paymentMethod: "COD",
      isPaid: false,
      paymentIntentId: "COD-TESTING3",
      shipping: { name: "Test User" },
      contact: { name: "Test User" },
      deliveryRegion: "Malta",
      deliveryMethod: "Pickup", // THIS IS THE FIX WE ARE TESTING
    });

    await order.save();
    console.log("Successfully created order!");
    console.log("Delivery Method saved as:", order.deliveryMethod);
    console.log("Order ID:", order._id.toString());
    process.exit(0);
  }).catch(err => {
    console.error(err);
    process.exit(1);
  });
