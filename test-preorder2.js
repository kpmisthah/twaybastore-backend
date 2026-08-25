import axios from "axios";

async function run() {
  const payload = {
    productId: "6a353e53330d94afec7c6cb9", // fabrics
    variantId: "6a353e53330d94afec7c6cba",
    variantName: "Blue",
    quantity: 1,
    decreaseStock: true
  };
  
  console.log("Sending...");
  const poRes = await axios.post("http://localhost:5000/api/admin/pre-orders", payload);
  console.log("Response:", poRes.data);
}
run();
