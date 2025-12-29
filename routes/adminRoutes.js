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

// GET /admin/orders - get all orders for admin with pagination, search, and filters
router.get("/orders", async (req, res) => {
  try {
    const {
      q,              // Search by order ID, customer name, email, phone
      status,         // Filter by status
      paymentMethod,  // Filter by payment method (CARD, COD)
      isPaid,         // Filter by payment status (true/false)
      startDate,      // Filter by date range start
      endDate,        // Filter by date range end
      sort = 'newest', // Sort: newest, oldest, amount-asc, amount-desc
      page = 1,
      limit = 20
    } = req.query;

    // Build filter
    let filter = {};

    // Filter by status
    if (status) {
      filter.status = status;
    }

    // Filter by payment method
    if (paymentMethod) {
      filter.paymentMethod = paymentMethod;
    }

    // Filter by payment status
    if (isPaid !== undefined) {
      filter.isPaid = isPaid === 'true';
    }

    // Filter by date range
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) {
        filter.createdAt.$gte = new Date(startDate);
      }
      if (endDate) {
        // Set to end of day
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = end;
      }
    }

    // Build sort option
    let sortOption = { createdAt: -1 }; // Default: newest first
    switch (sort) {
      case 'oldest':
        sortOption = { createdAt: 1 };
        break;
      case 'amount-asc':
        sortOption = { total: 1 };
        break;
      case 'amount-desc':
        sortOption = { total: -1 };
        break;
      default:
        sortOption = { createdAt: -1 };
    }

    // Pagination
    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 20));
    const skip = (pageNum - 1) * limitNum;

    // Execute query
    const [orders, total] = await Promise.all([
      Order.find(filter)
        .populate("user")
        .sort(sortOption)
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Order.countDocuments(filter)
    ]);

    // Search in results if query provided (for order ID, name, email, phone)
    let results = orders;
    if (q) {
      const searchLower = q.toLowerCase();
      results = orders.filter(order => {
        // Search in order ID
        if (order._id.toString().toLowerCase().includes(searchLower)) return true;

        // Search in shipping info
        if (order.shipping?.name?.toLowerCase().includes(searchLower)) return true;
        if (order.shipping?.email?.toLowerCase().includes(searchLower)) return true;
        if (order.shipping?.phone?.toLowerCase().includes(searchLower)) return true;

        // Search in contact info
        if (order.contact?.name?.toLowerCase().includes(searchLower)) return true;
        if (order.contact?.email?.toLowerCase().includes(searchLower)) return true;
        if (order.contact?.phone?.toLowerCase().includes(searchLower)) return true;

        // Search in user info
        if (order.user?.fullName?.toLowerCase().includes(searchLower)) return true;
        if (order.user?.email?.toLowerCase().includes(searchLower)) return true;
        if (order.user?.mobile?.toLowerCase().includes(searchLower)) return true;

        return false;
      });
    }

    // Calculate pagination metadata
    const totalPages = Math.ceil(total / limitNum);
    const hasNextPage = pageNum < totalPages;
    const hasPrevPage = pageNum > 1;

    res.json({
      orders: results,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages,
        hasNextPage,
        hasPrevPage,
        showing: results.length
      }
    });
  } catch (err) {
    console.error("Admin fetch orders error:", err);
    res.status(500).json({
      message: "Failed to fetch orders",
      error: process.env.NODE_ENV !== "production" ? err.message : undefined
    });
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
