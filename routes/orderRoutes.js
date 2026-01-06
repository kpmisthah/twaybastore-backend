import express from "express";
import crypto from "crypto";
import stripe from "../config/stripe.js";

import { sendTelegramMessage } from "../utils/telegram.js";
import Order from "../models/Order.js";
import Product from "../models/Product.js";
import User from "../models/User.js";
import Coupon from "../models/Coupon.js"; // ✅ coupon model
import {
  sendOrderMail,
  sendCancelMail,
  sendOtpEmail,
  sendNewOrderAlert,
} from "../utils/mailer.js";
import { orderRateLimiter } from "../middleware/rateLimiter.js";

const router = express.Router();

/* -------------------------------------------------------
   Helpers (OTP)
------------------------------------------------------- */
const hash = (s) => crypto.createHash("sha256").update(s).digest("hex");
const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes

// In-memory cancel OTP store (use Redis/DB in prod)
const cancelOtps = {}; // { [orderId]: { otpHash, expiresAt, lastSentAt? } }

/* -------------------------------------------------------
   User: Get my orders (with pagination and filters)
------------------------------------------------------- */
router.get("/my-orders/:userId", async (req, res) => {
  try {
    const {
      status,         // Filter by status
      startDate,      // Filter by date range
      endDate,
      page = 1,
      limit = 10
    } = req.query;

    // Build filter
    let filter = { user: req.params.userId };

    // Filter by status
    if (status) {
      filter.status = status;
    }

    // Filter by date range
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = end;
      }
    }

    // Pagination
    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(50, Math.max(1, parseInt(limit) || 10));
    const skip = (pageNum - 1) * limitNum;

    // Execute query
    const [orders, total] = await Promise.all([
      Order.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Order.countDocuments(filter)
    ]);

    // Calculate pagination metadata
    const totalPages = Math.ceil(total / limitNum);

    res.json({
      orders,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages,
        hasNextPage: pageNum < totalPages,
        hasPrevPage: pageNum > 1
      }
    });
  } catch (err) {
    console.error("Fetch my orders error:", err);
    res.status(500).json({
      message: "Failed to fetch user orders.",
      error: process.env.NODE_ENV !== "production" ? err.message : undefined
    });
  }
});


//  Place new order (on payment success or COD)

router.post("/", orderRateLimiter, async (req, res) => {
  try {
    const {
      userId,
      items,
      total,
      paymentIntentId,
      shipping,
      contact,
      couponCode,
    } = req.body;

    const user = await User.findById(userId);
    const pick = (a, b, def = "") => (a ?? b ?? def).toString().trim();

    const mergedShipping = {
      name: pick(shipping?.name, user?.fullName),
      email: pick(shipping?.email, user?.email),
      phone: pick(shipping?.phone, user?.mobile),
      address: pick(shipping?.address, user?.street),
      city: pick(shipping?.city, user?.city),
      state: pick(shipping?.state, user?.area),
      zip: pick(shipping?.zip, user?.zipCode),
      country: pick(shipping?.country, undefined, "MT"),
    };

    const mergedContact = {
      name: pick(contact?.name, mergedShipping.name),
      email: pick(contact?.email, mergedShipping.email),
      phone: pick(contact?.phone, mergedShipping.phone),
    };

    /* -------------------------------------------------------
       🎁 Coupon Logic — applies for both Stripe & COD
    ------------------------------------------------------- */
    let discountAmount = 0;
    let finalTotal = Number(total);
    let appliedCoupon = null;

    if (couponCode && userId) {
      const coupon = await Coupon.findOne({ code: couponCode, userId });
      if (
        coupon &&
        !coupon.usedAt &&
        coupon.expiresAt > new Date() &&
        coupon.reason === "WELCOME_NEW_USER"
      ) {
        const hasOrders = await Order.exists({ user: userId });
        if (!hasOrders) {
          discountAmount = Number(
            ((finalTotal * coupon.value) / 100).toFixed(2)
          );
          finalTotal = Number((finalTotal - discountAmount).toFixed(2));
          appliedCoupon = coupon;
          console.log(`✅ Applied ${coupon.value}% welcome discount`);
        } else {
          console.log("User already has an order; coupon skipped.");
        }
      } else {
        console.log("❌ Invalid or expired coupon:", couponCode);
      }
    }

    // 1️⃣ Normalize COD vs Stripe payment info
    const isCOD = paymentIntentId && String(paymentIntentId).startsWith("COD-");

    // 🔒 SECURITY: Verify Stripe Payment if not COD
    if (!isCOD && paymentIntentId) {
      try {
        // Check if this payment intent was already used
        const existingOrder = await Order.findOne({ paymentIntentId });
        if (existingOrder) {
          return res.status(400).json({
            message: "This payment has already been used for another order",
            orderId: existingOrder._id
          });
        }

        // Retrieve and verify payment intent from Stripe
        const intent = await stripe.paymentIntents.retrieve(paymentIntentId);

        if (intent.status !== "succeeded") {
          return res.status(400).json({
            message: `Payment validation failed. Status: ${intent.status}`,
            details: "Please complete the payment before placing order"
          });
        }

        // Verify Amount (Prevent using cheap payment for expensive order)
        const paidAmount = intent.amount; // in cents
        const orderAmount = Math.round(finalTotal * 100); // in cents

        // Allow only 2 cents variance (stricter than before)
        if (Math.abs(paidAmount - orderAmount) > 2) {
          console.error(`Payment amount mismatch: Paid ${paidAmount}, Expected ${orderAmount}`);
          return res.status(400).json({
            message: `Payment amount mismatch. Paid: €${(paidAmount / 100).toFixed(2)}, Expected: €${finalTotal.toFixed(2)}`,
            details: "Please contact support if you believe this is an error"
          });
        }

        // Verify the payment was made by the correct user (if userId in metadata)
        if (userId && intent.metadata?.userId && intent.metadata.userId !== userId) {
          return res.status(400).json({
            message: "Payment user mismatch",
            details: "This payment was made by a different user"
          });
        }

      } catch (err) {
        console.error("Payment verification failed:", err.message);
        return res.status(400).json({
          message: "Invalid or expired payment intent",
          details: process.env.NODE_ENV !== "production" ? err.message : undefined
        });
      }
    }

    // 2️⃣ Enrich product variants
    const fixedItems = await Promise.all(
      items.map(async (item) => {
        if ((item.color && item.dimensions) || !item.product) return item;

        const product = await Product.findById(item.product);
        if (
          !product ||
          !Array.isArray(product.variants) ||
          !product.variants.length
        )
          return { ...item, dimensions: item.dimensions || "N/A" };

        let variant = null;
        if (item.variantId) variant = product.variants.id(item.variantId);
        if (!variant) {
          variant = product.variants.find(
            (v) =>
              (!item.color ||
                (v.color &&
                  v.color.toLowerCase() === item.color.toLowerCase())) &&
              (!item.dimensions ||
                v.dimensions?.trim() === item.dimensions?.trim())
          );
        }

        return {
          ...item,
          color: variant?.color || item.color || "",
          dimensions: variant?.dimensions || item.dimensions || "N/A",
        };
      })
    );

    // 3️⃣ Create order with discount and proper payment flags
    const order = new Order({
      user: userId,
      items: fixedItems,
      total: finalTotal,
      finalTotal,
      discountAmount,
      couponCode: couponCode || null,
      paymentMethod: isCOD ? "COD" : "CARD",
      isPaid: !isCOD && !!paymentIntentId,
      paymentIntentId: paymentIntentId || undefined,
      paidAt: !isCOD && paymentIntentId ? new Date() : undefined,
      shipping: mergedShipping,
      contact: mergedContact,
    });

    await order.save();
    // 🚨 Telegram instant notification

    await sendTelegramMessage(
      `🛒 <b>New Order</b>\n` +
      `Order ID: ${order._id}\n` +
      `Amount: €${order.finalTotal}\n` +
      `Payment: ${order.paymentMethod}\n` +
      `Customer: ${mergedShipping.name}\n` +
      `Time: ${new Date().toLocaleString()}`
    );

    // ✅ Mark coupon as used
    if (appliedCoupon) {
      appliedCoupon.usedAt = new Date();
      appliedCoupon.orderId = order._id;
      await appliedCoupon.save();
    }

    // 4️⃣ Decrement stock
    for (const item of fixedItems) {
      const product = await Product.findById(item.product);
      if (!product) continue;
      if (item.color && item.dimensions && product.variants?.length) {
        const variant = product.variants.find(
          (v) =>
            v.color?.toLowerCase() === item.color?.toLowerCase() &&
            v.dimensions?.trim() === item.dimensions?.trim()
        );
        if (variant)
          variant.stock = Math.max(0, (variant.stock || 0) - item.qty);
      }
      await product.save();
    }

    // 5️⃣ Emails
    if (user?.email) {
      try {
        await sendOrderMail(user.email, user.fullName, order);
      } catch (err) {
        console.error("Order email error:", err);
      }
    }

    try {
      await sendNewOrderAlert({
        to: process.env.ORDER_ALERT_EMAIL,
        order,
        customerName: mergedShipping.name || user?.fullName || "Customer",
      });
    } catch (e) {
      console.error("Internal order alert error:", e);
    }

    res.status(201).json(order);
  } catch (err) {
    console.error("Order placement error:", err);
    res
      .status(500)
      .json({ message: "Server error placing order", error: err.message });
  }
});

/* -------------------------------------------------------
   Delete a cancelled order
------------------------------------------------------- */
router.delete("/delete/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ message: "Order not found." });
    if (order.status !== "Cancelled") {
      return res
        .status(400)
        .json({ message: "Only cancelled orders can be deleted." });
    }

    await Order.findByIdAndDelete(orderId);
    res.status(200).json({ message: "Order deleted successfully." });
  } catch (err) {
    console.error("Delete order error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

/* -------------------------------------------------------
   Get all orders (simple)
------------------------------------------------------- */
router.get("/", async (_req, res) => {
  try {
    const orders = await Order.find();
    res.json(orders);
  } catch (err) {
    console.error("Fetch orders error:", err);
    res.status(500).json({ message: "Failed to fetch orders." });
  }
});

/* -------------------------------------------------------
   Admin: Get all orders (with user)
------------------------------------------------------- */
router.get("/admin/orders", async (_req, res) => {
  try {
    const orders = await Order.find().populate("user");
    res.json(orders);
  } catch (err) {
    console.error("Admin fetch orders error:", err);
    res.status(500).json({ message: "Failed to fetch orders." });
  }
});

/* -------------------------------------------------------
   Admin: Update order status (after 2 hours)
------------------------------------------------------- */
router.put("/:orderId/status", async (req, res) => {
  try {
    const { status } = req.body;
    const allowed = [
      "Processing",
      "Packed",
      "Shipped",
      "Delivered",
      "Cancelled",
    ];
    if (!allowed.includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    const order = await Order.findById(req.params.orderId);
    if (!order) return res.status(404).json({ message: "Order not found" });

    const createdAt = new Date(order.createdAt).getTime();
    if (Date.now() - createdAt < 2 * 60 * 60 * 1000) {
      return res.status(403).json({
        message:
          "Order status cannot be changed until 2 hours after placement.",
      });
    }

    order.status = status;
    await order.save();
    res.json(order);
  } catch (err) {
    console.error("Update status error:", err);
    res.status(500).json({ message: "Failed to update status." });
  }
});

/* -------------------------------------------------------
   Send OTP for order cancellation
------------------------------------------------------- */
router.post("/:orderId/send-cancel-otp", async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId).populate("user");
    if (!order) return res.status(404).json({ message: "Order not found" });

    if (
      ["Packed", "Shipped", "Delivered", "Cancelled"].includes(order.status)
    ) {
      return res.status(400).json({ message: "Order cannot be cancelled" });
    }

    if (!order.user?.email) {
      return res
        .status(400)
        .json({ message: "No email on file for this account." });
    }

    const existing = cancelOtps[order._id];
    const now = Date.now();
    if (existing?.lastSentAt && now - existing.lastSentAt < 60 * 1000) {
      const sec = Math.ceil((60 * 1000 - (now - existing.lastSentAt)) / 1000);
      return res
        .status(429)
        .json({ message: `Please wait ${sec}s before requesting a new OTP.` });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    cancelOtps[order._id] = {
      otpHash: hash(otp),
      expiresAt: now + OTP_TTL_MS,
      lastSentAt: now,
    };

    await sendOtpEmail(order.user.email, otp, "Order Cancellation");

    res.json({ success: true, message: "OTP sent to your email." });
  } catch (err) {
    console.error("Send cancel OTP error:", err);
    res.status(500).json({ message: "Error sending OTP." });
  }
});

/* -------------------------------------------------------
   Cancel order with OTP
------------------------------------------------------- */
router.post("/:orderId/cancel", async (req, res) => {
  try {
    const { reason, otp } = req.body;
    const order = await Order.findById(req.params.orderId).populate("user");
    if (!order) return res.status(404).json({ message: "Order not found" });

    if (Date.now() - new Date(order.createdAt).getTime() > 2 * 60 * 60 * 1000) {
      return res
        .status(400)
        .json({ message: "Cannot cancel order after 2 hours from placement." });
    }

    if (["Packed", "Delivered", "Cancelled"].includes(order.status)) {
      return res.status(400).json({ message: "Order cannot be cancelled" });
    }

    const store = cancelOtps[order._id];
    if (!store) return res.status(400).json({ message: "OTP required." });
    if (!otp)
      return res
        .status(400)
        .json({ message: "Enter the OTP sent to your email." });

    if (store.expiresAt < Date.now()) {
      delete cancelOtps[order._id];
      return res
        .status(400)
        .json({ message: "OTP expired. Please request a new OTP." });
    }
    if (store.otpHash !== hash(otp)) {
      return res.status(400).json({ message: "Invalid OTP." });
    }

    order.status = "Cancelled";
    order.cancelReason = reason || "";
    await order.save();

    if (order.user?.email) {
      try {
        await sendCancelMail(order.user.email, order.user.fullName, order);
      } catch (e) {
        console.error("Cancel email error:", e);
      }
    }

    delete cancelOtps[order._id];
    res.json({ success: true });
  } catch (err) {
    console.error("Cancel order error:", err);
    res.status(500).json({ message: "Error cancelling order." });
  }
});

/* -------------------------------------------------------
   Guest checkout (still supports coupon)
------------------------------------------------------- */
router.post("/guest", orderRateLimiter, async (req, res) => {
  try {
    const { items, total, paymentIntentId, guestInfo, couponCode } = req.body;

    if (
      !guestInfo ||
      !guestInfo.email ||
      !guestInfo.name ||
      !guestInfo.address
    ) {
      return res.status(400).json({ message: "Missing guest information" });
    }

    let discountAmount = 0;
    let finalTotal = Number(total);
    if (couponCode && String(couponCode).toUpperCase().startsWith("WELCOME")) {
      discountAmount = Number((finalTotal * 0.05).toFixed(2));
      finalTotal = Number((finalTotal - discountAmount).toFixed(2));
    }

    const isCOD = paymentIntentId && String(paymentIntentId).startsWith("COD-");

    // 🔒 SECURITY: Verify Stripe (Guest)
    if (!isCOD && paymentIntentId) {
      try {
        // Check if this payment intent was already used
        const existingOrder = await Order.findOne({ paymentIntentId });
        if (existingOrder) {
          return res.status(400).json({
            message: "This payment has already been used for another order",
            orderId: existingOrder._id
          });
        }

        // Retrieve and verify payment intent from Stripe
        const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
        if (intent.status !== "succeeded") {
          return res.status(400).json({
            message: `Payment validation failed. Status: ${intent.status}`,
            details: "Please complete the payment before placing order"
          });
        }

        // Verify Amount (Guest)
        const paidAmount = intent.amount;
        const orderAmount = Math.round(finalTotal * 100);
        if (Math.abs(paidAmount - orderAmount) > 2) {
          console.error(`Guest payment amount mismatch: Paid ${paidAmount}, Expected ${orderAmount}`);
          return res.status(400).json({
            message: `Payment amount mismatch. Paid: €${(paidAmount / 100).toFixed(2)}, Expected: €${finalTotal.toFixed(2)}`,
            details: "Please contact support if you believe this is an error"
          });
        }

      } catch (err) {
        console.error("Guest payment verification failed:", err.message);
        return res.status(400).json({
          message: "Invalid or expired payment intent",
          details: process.env.NODE_ENV !== "production" ? err.message : undefined
        });
      }
    }

    const shipping = {
      name: guestInfo.name,
      email: guestInfo.email,
      phone: guestInfo.phone || "",
      address: guestInfo.address,
      city: guestInfo.city || "",
      state: guestInfo.area || "",
      zip: guestInfo.zipCode || "",
      country: guestInfo.country || "MT",
    };

    const contact = {
      name: guestInfo.name,
      email: guestInfo.email,
      phone: guestInfo.phone || "",
    };

    const fixedItems = await Promise.all(
      items.map(async (item) => {
        if ((item.color && item.dimensions) || !item.product) return item;
        const product = await Product.findById(item.product);
        if (!product || !Array.isArray(product.variants)) {
          return { ...item, dimensions: item.dimensions || "N/A" };
        }
        const variant = product.variants.find(
          (v) =>
            (!item.color ||
              v.color?.toLowerCase() === item.color?.toLowerCase()) &&
            (!item.dimensions ||
              v.dimensions?.trim() === item.dimensions?.trim())
        );
        return {
          ...item,
          color: variant?.color || item.color || "",
          dimensions: variant?.dimensions || item.dimensions || "N/A",
        };
      })
    );

    const order = new Order({
      user: null,
      items: fixedItems,
      total: finalTotal,
      finalTotal,
      discountAmount,
      couponCode: couponCode || null,
      paymentMethod: isCOD ? "COD" : "CARD",
      isPaid: !isCOD && !!paymentIntentId,
      paymentIntentId: paymentIntentId || undefined,
      paidAt: !isCOD && paymentIntentId ? new Date() : undefined,
      shipping,
      contact,
    });

    await order.save();

    for (const item of fixedItems) {
      const product = await Product.findById(item.product);
      if (!product) continue;
      const variant = product.variants?.find(
        (v) =>
          v.color?.toLowerCase() === item.color?.toLowerCase() &&
          v.dimensions?.trim() === item.dimensions?.trim()
      );
      if (variant) {
        variant.stock = Math.max(0, (variant.stock || 0) - item.qty);
        await product.save();
      }
    }

    try {
      await sendOrderMail(guestInfo.email, guestInfo.name, order);
    } catch (e) {
      console.error("Guest order email error:", e.message);
    }

    try {
      await sendNewOrderAlert({
        to: process.env.ORDER_ALERT_EMAIL,
        order,
        customerName: guestInfo.name,
      });
    } catch (e) {
      console.error("Internal order alert error:", e);
    }

    res.status(201).json(order);
  } catch (err) {
    console.error("Guest order placement error:", err);
    res.status(500).json({
      message: "Server error placing guest order",
      error: err.message,
    });
  }
});

export default router;
