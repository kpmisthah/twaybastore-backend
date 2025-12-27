import mongoose from "mongoose";
import dotenv from "dotenv";
import Product from "../models/Product.js";
import { generateEmbedding } from "./embedding.js";

dotenv.config();

const MONGO_URI = process.env.MONGO_URI;

const run = async () => {
  console.log("⏳ Connecting to DB...");
  await mongoose.connect(MONGO_URI);
  console.log("✅ DB Connected");

  const products = await Product.find({});
  console.log(`📦 Found ${products.length} products`);

  for (const p of products) {
    const text = `${p.name} ${p.description} ${p.category} ${p.brand}`;
    
    const embed = await generateEmbedding(text);

    p.embedding = embed;
    await p.save();

    console.log(`✔ Updated: ${p.name}`);
  }

  console.log("🎉 All embeddings generated successfully.");
  process.exit(0);
};

run();
