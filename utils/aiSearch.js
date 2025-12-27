import Product from "../models/Product.js";
import { generateEmbedding } from "./embedding.js";

// Clean text
const clean = (txt = "") =>
  txt.toLowerCase().replace(/[^a-z0-9 ]/gi, "").trim();

// Pure cosine similarity
function cosineSimilarity(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// MAIN semantic search
export const aiProductSearch = async (query) => {
  const q = clean(query);
  if (!q) return [];

  const qVec = await generateEmbedding(q);

  const products = await Product.find(
    { embedding: { $exists: true, $ne: [] } },
    "name description category brand embedding"
  );

  const ranked = products
    .map((p) => ({
      product: p,
      score: cosineSimilarity(qVec, p.embedding),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  return ranked;
};

// Suggestions only
export const aiSuggestions = async (query) => {
  const results = await aiProductSearch(query);

  return [...new Set(results.map((r) => r.product.name))].slice(0, 5);
};
