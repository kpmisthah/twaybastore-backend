import { pipeline } from "@xenova/transformers";

// Load embedding model once
let embedder;

export const generateEmbedding = async (text) => {
  try {
    if (!embedder) {
      embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
    }

    const output = await embedder(text, {
      pooling: "mean",
      normalize: true,
    });

    return Array.from(output.data);
  } catch (err) {
    console.log("❌ Local embedding error:", err.message);
    return [];
  }
};
