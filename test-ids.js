import mongoose from "mongoose";
import Product from "./models/Product.js";

mongoose.connect("mongodb://localhost:27017/ecommerce").then(async () => {
  const p = await Product.findById("6a145a89c7bb301de753c0bd");
  console.log(p ? p.name : "Not found");
  process.exit();
}).catch(console.error);
