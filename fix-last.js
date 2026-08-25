import mongoose from "mongoose";
import Product from "./models/Product.js";
import dotenv from "dotenv";

dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  
  const p1 = await Product.findOne({ name: /Car vent holder/i });
  console.log("p1:", p1 ? "found" : "not found");
  if(p1) {
    if(p1.variants && p1.variants.length > 0) {
      p1.variants[0].woltId = "6a145a89c7bb301de753c009";
      p1.markModified('variants');
    } else {
      p1.woltId = "6a145a89c7bb301de753c009";
      p1.markModified('woltId');
    }
    await p1.save();
  }

  const p2 = await Product.findOne({ name: /Universal Gravity/i });
  console.log("p2:", p2 ? "found" : "not found");
  if(p2) {
    if(p2.variants && p2.variants.length > 0) {
      p2.variants[0].woltId = "6a145a89c7bb301de753c0c8";
      p2.markModified('variants');
    } else {
      p2.woltId = "6a145a89c7bb301de753c0c8";
      p2.markModified('woltId');
    }
    await p2.save();
  }
  
  const p3 = await Product.findOne({ name: /Rubber Coated Dumbbell/i });
  console.log("p3:", p3 ? "found" : "not found");
  if(p3) {
    if(p3.variants && p3.variants.length > 0) {
      let v = p3.variants.find(v => String(v.dimensions).includes("2.5"));
      if(v) v.woltId = "6a145a89c7bb301de753c0f0";
      p3.markModified('variants');
    }
    await p3.save();
  }

  const p4 = await Product.findOne({ name: /Heavy Punching Boxing/i });
  if(p4) {
    if(p4.variants) {
      let v = p4.variants.find(v => String(v.dimensions).includes("160"));
      if(v) v.woltId = "6a145a89c7bb301de753bfe5";
      p4.markModified('variants');
    }
    await p4.save();
  }

  process.exit();
}
run().catch(console.error);
