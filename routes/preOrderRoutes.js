import express from "express";
import PreOrder from "../models/PreOrder.js";
import Product from "../models/Product.js";
import StoreInventory from "../models/StoreInventory.js";

const router = express.Router();

// GET all pre-orders
router.get("/", async (req, res) => {
  try {
    const preOrders = await PreOrder.find().populate("product").sort({ createdAt: -1 });
    res.json({ success: true, data: preOrders });
  } catch (err) {
    console.error("Error fetching pre-orders:", err);
    res.status(500).json({ success: false, message: "Server error fetching pre-orders" });
  }
});

// POST create new pre-order
router.post("/", async (req, res) => {
  try {
    const { productId, variantId, variantName, quantity, date, deposit, balance, decreaseStock } = req.body;

    if (!productId || !quantity) {
      return res.status(400).json({ success: false, message: "Product and quantity are required" });
    }

    // Verify product exists
    const product = await Product.findById(productId);
    if (!product) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }

    // Create PreOrder
    const newPreOrder = new PreOrder({
      product: productId,
      variantId,
      variantName,
      quantity: Number(quantity),
      date: date ? new Date(date) : new Date(),
      deposit: Number(deposit) || 0,
      balance: Number(balance) || 0,
    });
    
    await newPreOrder.save();

    // Decrease global stock if requested
    if (decreaseStock) {
      let qtyToDecrease = Number(quantity);
      if (product.variants && product.variants.length > 0) {
        if (variantId) {
          const vIndex = product.variants.findIndex(v => v._id.toString() === variantId);
          if (vIndex !== -1) {
            product.variants[vIndex].stock = Math.max(0, (product.variants[vIndex].stock || 0) - qtyToDecrease);
          }
        } else {
          for (let i = 0; i < product.variants.length; i++) {
            if (qtyToDecrease <= 0) break;
            if (typeof product.variants[i].stock === "number" && product.variants[i].stock > 0) {
              const decr = Math.min(product.variants[i].stock, qtyToDecrease);
              product.variants[i].stock -= decr;
              qtyToDecrease -= decr;
            }
          }
        }
      } else {
        if (typeof product.stock === "number") {
          product.stock = Math.max(0, product.stock - qtyToDecrease);
        }
      }
      product.markModified("variants");
      await product.save();
      
      // Update store inventory records to stay in sync
      if (variantId) {
        const storeRec = await StoreInventory.findOne({ product: productId, variantId });
        if (storeRec) {
           storeRec.locations.store = Math.max(0, storeRec.locations.store - qtyToDecrease);
           await storeRec.save();
        }
      } else {
        const storeRec = await StoreInventory.findOne({ product: productId, variant: "default" });
        if (storeRec) {
           storeRec.locations.store = Math.max(0, storeRec.locations.store - qtyToDecrease);
           await storeRec.save();
        }
      }
    }

    // Populate product for response
    await newPreOrder.populate("product");

    res.status(201).json({ success: true, data: newPreOrder, message: "Pre-order created successfully" });
  } catch (err) {
    console.error("Error creating pre-order:", err);
    res.status(500).json({ success: false, message: "Server error creating pre-order" });
  }
});

// PUT update pre-order
router.put("/:id", async (req, res) => {
  try {
    const { deposit, balance, date, quantity } = req.body;
    const preOrder = await PreOrder.findById(req.params.id);
    
    if (!preOrder) {
      return res.status(404).json({ success: false, message: "Pre-order not found" });
    }

    if (deposit !== undefined) preOrder.deposit = Number(deposit);
    if (balance !== undefined) preOrder.balance = Number(balance);
    if (date !== undefined) preOrder.date = new Date(date);
    if (quantity !== undefined) preOrder.quantity = Number(quantity);

    await preOrder.save();
    await preOrder.populate("product");

    res.json({ success: true, data: preOrder, message: "Pre-order updated successfully" });
  } catch (err) {
    console.error("Error updating pre-order:", err);
    res.status(500).json({ success: false, message: "Server error updating pre-order" });
  }
});

// DELETE pre-order
router.delete("/:id", async (req, res) => {
  try {
    const preOrder = await PreOrder.findByIdAndDelete(req.params.id);
    if (!preOrder) {
      return res.status(404).json({ success: false, message: "Pre-order not found" });
    }
    res.json({ success: true, message: "Pre-order deleted successfully" });
  } catch (err) {
    console.error("Error deleting pre-order:", err);
    res.status(500).json({ success: false, message: "Server error deleting pre-order" });
  }
});

export default router;
