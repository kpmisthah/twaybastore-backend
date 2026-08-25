import axios from "axios";

async function run() {
  try {
    // 1. Fetch products to get the 'fabrics' product
    const prodRes = await axios.get("http://localhost:5000/api/products");
    const products = prodRes.data.products;
    const fabrics = products.find(p => p.name === "fabrics");
    
    if (!fabrics) {
      console.log("Fabrics product not found");
      return;
    }
    
    console.log("Before Stock (Variant 0):", fabrics.variants[0].stock);
    const variantId = fabrics.variants[0]._id;
    
    // 2. Add PreOrder
    const payload = {
      productId: fabrics._id,
      variantId: variantId,
      variantName: "Blue",
      quantity: 1,
      date: new Date().toISOString(),
      deposit: 0,
      balance: 0,
      decreaseStock: true
    };
    
    console.log("Creating preorder...");
    const poRes = await axios.post("http://localhost:5000/api/admin/pre-orders", payload);
    console.log("Preorder response:", poRes.data.success);
    
    // 3. Fetch products again
    const prodRes2 = await axios.get("http://localhost:5000/api/products");
    const fabrics2 = prodRes2.data.products.find(p => p.name === "fabrics");
    
    console.log("After Stock (Variant 0):", fabrics2.variants[0].stock);
  } catch (err) {
    console.error(err.response ? err.response.data : err.message);
  }
}
run();
