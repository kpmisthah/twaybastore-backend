// routes/admin.js
import express from "express";
const router = express.Router();

import Product from "../models/Product.js";
import Order from "../models/Order.js";
import { sendBroadcastEmail } from "../utils/mailer.js";
import User from "../models/User.js"; // 👈 add this at the top with other imports

const categoryLabels = [
  "Home & Kitchen",
  "Fitness",
  "Gadgets",
  "Shelving",
  "Tools",
  "Camping",
  "Car Accessories",
];

router.get("/dashboard-stats", async (req, res) => {
  try {
    const products = await Product.find();
    const orders = await Order.find();

    const productCount = products.length;

    // Count PRODUCTS (not stock) by category
    const productCountByCategory = {};
    for (const cat of categoryLabels) productCountByCategory[cat] = 0;
    products.forEach((prod) => {
      if (
        prod.category &&
        productCountByCategory.hasOwnProperty(prod.category)
      ) {
        productCountByCategory[prod.category]++;
      }
    });

    const orderCount = orders.length;
    const ordersByStatus = {};
    orders.forEach((order) => {
      ordersByStatus[order.status] = (ordersByStatus[order.status] || 0) + 1;
    });

    res.json({
      productCount,
      productCountByCategory, // << this is now correct
      orderCount,
      ordersByStatus,
    });
  } catch (err) {
    res
      .status(500)
      .json({ message: "Error fetching dashboard stats", error: err.message });
  }
});

// POST /admin/send-broadcast
router.post("/send-broadcast", async (req, res) => {
  try {
    const { subject, content } = req.body;
    if (!subject || !content) {
      return res
        .status(400)
        .json({ message: "Subject and content are required." });
    }

    // ✅ Get only users who accepted promotional emails
    const users = await User.find({
      sendAdsEmail: true,
      email: { $exists: true, $ne: "" },
    }).select("email");

    const uniqueEmails = [...new Set(users.map((u) => u.email.trim()))];

    if (uniqueEmails.length === 0) {
      return res.status(404).json({
        message: "No opted-in users found. No emails sent.",
      });
    }

    // ✅ Batch send to avoid limits (e.g. Gmail 500 limit)
    const batchSize = 400;
    let sentCount = 0;

    for (let i = 0; i < uniqueEmails.length; i += batchSize) {
      const batch = uniqueEmails.slice(i, i + batchSize);
      await sendBroadcastEmail({
        recipients: batch,
        subject,
        htmlContent: content,
      });
      sentCount += batch.length;
      console.log(
        `✅ Sent batch ${i / batchSize + 1} (${batch.length} emails)`
      );
    }

    res.json({
      success: true,
      total: sentCount,
      message: `Broadcast sent to ${sentCount} opted-in users.`,
    });
  } catch (err) {
    console.error("❌ Broadcast email error:", err);
    res.status(500).json({
      message: "Failed to send broadcast email",
      error: err.message,
    });
  }
});

// GET /admin/orders - get all orders for admin with payment info
router.get("/orders", async (req, res) => {
  try {
    const orders = await Order.find().populate("user"); // you can add .sort({createdAt:-1}) if you want latest first
    res.json(orders);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch orders." });
  }
});

// POST /admin/mark-paid
router.post("/mark-paid", async (req, res) => {
  try {
    const { orderId, paymentIntentId } = req.body;
    if (!orderId || !paymentIntentId)
      return res
        .status(400)
        .json({ message: "Order ID and paymentIntentId required." });

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ message: "Order not found." });

    order.isPaid = true;
    order.paidAt = new Date();
    order.paymentIntentId = paymentIntentId;
    await order.save();

    res.json({ success: true, order });
  } catch (err) {
    res
      .status(500)
      .json({ message: "Failed to mark order as paid.", error: err.message });
  }
});

router.patch("/products/:id/adjust-stock", async (req, res) => {
  try {
    const { quantity, variantId } = req.body;
    const qty = Number(quantity);

    if (!Number.isInteger(qty) || qty < 1) {
      return res.status(400).json({
        code: "INVALID_QUANTITY",
        message: "Invalid quantity: must be a positive integer.",
      });
    }

    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({
        code: "PRODUCT_NOT_FOUND",
        message: `Product not found: ${req.params.id}`,
      });
    }

    if (variantId) {
      const variant = product.variants.id(variantId);
      if (!variant) {
        return res.status(404).json({
          code: "VARIANT_NOT_FOUND",
          message: `Variant not found for ID: ${variantId}`,
        });
      }
      if (typeof variant.stock !== "number") {
        return res.status(400).json({
          code: "VARIANT_NO_STOCK_FIELD",
          message: "Variant does not have a valid stock field.",
        });
      }
      if (variant.stock < qty) {
        return res.status(400).json({
          code: "INSUFFICIENT_VARIANT_STOCK",
          message: `Not enough stock in variant. Current: ${variant.stock}, Tried to minus: ${qty}`,
        });
      }
      variant.stock -= qty;
    } else {
      if (typeof product.stock !== "number") {
        return res.status(400).json({
          code: "PRODUCT_NO_STOCK_FIELD",
          message: "Product does not have a valid stock field.",
        });
      }
      if (product.stock < qty) {
        return res.status(400).json({
          code: "INSUFFICIENT_MAIN_STOCK",
          message: `Not enough stock in main product. Current: ${product.stock}, Tried to minus: ${qty}`,
        });
      }
      product.stock -= qty;
    }

    await product.save();
    res.json({ message: "Stock adjusted successfully", product });
  } catch (err) {
    console.error("Error in adjust stock route:", err);
    res.status(500).json({
      code: "SERVER_ERROR",
      message: "Unexpected server error during stock adjustment.",
      error: err.message,
    });
  }
});

// PATCH /admin/products/:id/add-stock
router.patch("/products/:id/add-stock", async (req, res) => {
  try {
    const { quantity, variantId } = req.body;
    const qty = Number(quantity);

    if (!Number.isInteger(qty) || qty < 1) {
      return res.status(400).json({
        code: "INVALID_QUANTITY",
        message: "Invalid quantity: must be a positive integer.",
      });
    }

    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({
        code: "PRODUCT_NOT_FOUND",
        message: `Product not found: ${req.params.id}`,
      });
    }

    if (variantId) {
      const variant = product.variants.id(variantId);
      if (!variant) {
        return res.status(404).json({
          code: "VARIANT_NOT_FOUND",
          message: `Variant not found for ID: ${variantId}`,
        });
      }
      if (typeof variant.stock !== "number") {
        return res.status(400).json({
          code: "VARIANT_NO_STOCK_FIELD",
          message: "Variant does not have a valid stock field.",
        });
      }
      variant.stock += qty;
    } else {
      if (typeof product.stock !== "number") {
        return res.status(400).json({
          code: "PRODUCT_NO_STOCK_FIELD",
          message: "Product does not have a valid stock field.",
        });
      }
      product.stock += qty;
    }

    await product.save();
    res.json({ message: "Stock added successfully", product });
  } catch (err) {
    console.error("Error in add stock route:", err);
    res.status(500).json({
      code: "SERVER_ERROR",
      message: "Unexpected server error during stock addition.",
      error: err.message,
    });
  }
});

export default router;
