import axios from "axios";
async function run() {
  const prodRes2 = await axios.get("http://localhost:5000/api/products");
  const fabrics2 = prodRes2.data.products.find(p => p.name === "fabrics");
  console.log("After Stock (Variant 0):", fabrics2.variants[0].stock);
}
run();
