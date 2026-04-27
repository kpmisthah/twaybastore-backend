import express from "express";
import crypto from "crypto";
import stripe from "../config/stripe.js";

import { sendTelegramMessage, escapeHTML } from "../utils/telegram.js";
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
import { orderRateLimiter, codRateLimiter } from "../middleware/rateLimiter.js";
import auth from "../middleware/auth.js";
import { requireAdmin } from "../middleware/adminAuth.js";

const router = express.Router();

/* -------------------------------------------------------
   Helpers (OTP)
------------------------------------------------------- */
const hash = (s) => crypto.createHash("sha256").update(s).digest("hex");
const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes

// In-memory cancel OTP store (use Redis/DB in prod)
const cancelOtps = {}; // { [orderId]: { otpHash, expiresAt, lastSentAt? } }

/* -------------------------------------------------------
   Helpers (Stock)
------------------------------------------------------- */
const adjustStock = async (items, direction = "decrement") => {
  for (const item of items) {
    try {
      if (!item.product) continue;

      // item.product might be an ID or a populated object
      const productId = item.product._id || item.product;
      const product = await Product.findById(productId);
      if (!product) {
        console.warn(`Product not found for adjustment: ${productId}`);
        continue;
      }

      const change = direction === "decrement" ? -item.qty : item.qty;
      console.log(`${direction === 'decrement' ? 'Decrementing' : 'Restoring'} stock for product: ${product.name} (ID: ${product._id}) by ${item.qty}`);

      // 1. Variant adjustment
      if (item.color && item.dimensions && product.variants?.length) {
        const variant = product.variants.find(
          (v) =>
            v.color?.toLowerCase() === item.color?.toLowerCase() &&
            v.dimensions?.trim() === item.dimensions?.trim()
        );
        if (variant) {
          variant.stock = Math.max(0, (variant.stock || 0) + change);
          console.log(`Updated variant [${variant.color} / ${variant.dimensions}] stock to: ${variant.stock}`);
        } else {
          console.warn(`Variant not found for product ${product._id} with Color: ${item.color}, Dim: ${item.dimensions}`);
        }
      }

      // 2. Base stock adjustment
      product.stock = Math.max(0, (product.stock || 0) + change);
      console.log(`Updated base stock to: ${product.stock}`);

      await product.save();
    } catch (err) {
      console.error(`Stock adjustment error for ${item.product}:`, err);
    }
  }
};

/* -------------------------------------------------------
   User: Get my orders (with pagination and filters)
------------------------------------------------------- */
router.get("/my-orders/:userId", auth, async (req, res) => {
  try {
    const {
      status,
      startDate,
      endDate,
      q,             // text search: order ID suffix or item name
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

    // Text search: match order _id suffix or item name
    if (q && q.trim()) {
      const trimmed = q.trim();
      filter.$or = [
        { $expr: { $regexMatch: { input: { $toString: "$_id" }, regex: trimmed, options: "i" } } },
        { "items.name": { $regex: trimmed, $options: "i" } },
      ];
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

router.post("/", orderRateLimiter, auth, async (req, res) => {
  try {
    const {
      userId,
      items,
      total,
      paymentIntentId,
      shipping,
      contact,
      deliveryRegion,
      deliveryMethod,
      couponCode,
    } = req.body;

    // 🔒 SECURITY: PREVENT DUPLICATE ORDERS (Webhook vs Frontend Race)
    if (paymentIntentId) {
      const existing = await Order.findOne({ paymentIntentId });
      if (existing) {
        console.log(`ℹ️  Order for ${paymentIntentId} already exists. Skipping duplicate.`);
        return res.status(200).json(existing);
      }
    }

    // 🔒 SECURITY: Verify the userId matches the authenticated user
    if (userId && userId !== req.userId.toString()) {
      return res.status(403).json({ message: "User ID mismatch. Cannot place orders for other users." });
    }

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
      } else if (couponCode && String(couponCode).toUpperCase() === "TWAYBA5") {
        if (finalTotal >= 40) {
          const usedAlready = await Order.exists({
            user: userId,
            couponCode: "TWAYBA5",
            status: { $ne: "Cancelled" }
          });
          if (!usedAlready) {
            discountAmount = 5;
            finalTotal = Number((finalTotal - discountAmount).toFixed(2));
            console.log(`✅ Applied €5 flash offer discount`);
          } else {
            console.log("⚠️ TWAYBA5 already used by this user.");
          }
        }
      } else {
        console.log("❌ Invalid or expired coupon:", couponCode);
      }
    }

    /* -------------------------------------------------------
       🚚 Delivery Logic
    ------------------------------------------------------- */
    let deliveryCharge = 0;
    const isGozo = deliveryRegion === "Gozo";
    // Recalculate subtotal for delivery threshold validation
    let subTotalForDelivery = 0;
    for (const item of items) {
      const product = await Product.findById(item.product);
      if (product) {
        let price = product.price;
        if (item.color && item.dimensions && product.variants?.length) {
          const variant = product.variants.find(v =>
            v.color?.toLowerCase() === item.color?.toLowerCase() &&
            v.dimensions?.trim() === item.dimensions?.trim()
          );
          if (variant?.price) price = variant.price;
        }
        subTotalForDelivery += price * item.qty;
      }
    }

    if (isPickup || deliveryMethod === "Pickup") {
      deliveryCharge = 0;
    } else if (isGozo) {
      deliveryCharge = subTotalForDelivery >= 70 ? 0 : 10;
    } else {
      deliveryCharge = subTotalForDelivery >= 35 ? 0 : 5; // Malta tiered
    }

    // 1️⃣ Normalize COD vs Pickup vs Stripe payment info
    const isCOD = paymentIntentId && String(paymentIntentId).startsWith("COD-");
    const isPickup = paymentIntentId && String(paymentIntentId).startsWith("PICKUP-");

    // 🔒 SECURITY: For COD/Pickup orders, recalculate total from DB prices (NEVER trust client)
    if (isCOD || isPickup) {
      let serverTotal = 0;
      for (const item of items) {
        const product = await Product.findById(item.product);
        if (!product) {
          return res.status(400).json({ message: `Product not found: ${item.product}` });
        }
        let price = product.price;
        if (item.color && item.dimensions && product.variants?.length) {
          const variant = product.variants.find(v =>
            v.color?.toLowerCase() === item.color?.toLowerCase() &&
            v.dimensions?.trim() === item.dimensions?.trim()
          );
          if (variant?.price) price = variant.price;
        }
        serverTotal += price * item.qty;
      }
      const expectedTotal = Number((serverTotal - discountAmount + deliveryCharge).toFixed(2));
      if (Math.abs(expectedTotal - Number(total)) > 1) {
        console.error(`COD price mismatch: Client sent ${total}, Server calculated ${expectedTotal}`);
        return res.status(400).json({
          message: "Price mismatch detected",
          details: "The order total doesn't match current prices. Please refresh and try again."
        });
      }
      finalTotal = expectedTotal;
    } else {
      // For Stripe, we still want to ensure the finalTotal we use for verification includes delivery
      // Actually total from body SHOULD already have it, but let's be explicit.
      // Recalculate what the total SHOULD be to compare with Stripe
      const serverSubTotal = items.reduce((sum, item) => sum + (item.price * item.qty), 0); // We already have subTotalForDelivery
      finalTotal = Number((subTotalForDelivery - discountAmount + deliveryCharge).toFixed(2));
    }

    // 🔒 SECURITY: Verify Stripe Payment if not COD or Pickup
    if (!isCOD && !isPickup && paymentIntentId) {
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

    // 🔒 SECURITY: Validate stock availability BEFORE creating order
    for (const item of items) {
      const product = await Product.findById(item.product);
      if (!product) {
        return res.status(400).json({ message: `Product not found: ${item.product}` });
      }
      if (item.color && item.dimensions && product.variants?.length) {
        const variant = product.variants.find(v =>
          v.color?.toLowerCase() === item.color?.toLowerCase() &&
          v.dimensions?.trim() === item.dimensions?.trim()
        );
        if (variant && variant.stock !== undefined && variant.stock < item.qty) {
          return res.status(400).json({
            message: `Insufficient stock for ${product.name} (${item.color}, ${item.dimensions}). Available: ${variant.stock}`
          });
        }
      }
    }

    // 2️⃣ Enrich product variants (Populate missing color/dims if variants exist)
    const fixedItems = await Promise.all(
      items.map(async (item) => {
        if (!item.product) return item;

        const product = await Product.findById(item.product).lean();
        if (!product || !product.variants?.length)
          return { ...item, color: item.color || "", dimensions: item.dimensions || "" };

        // Try to match or fallback to first variant
        let variant = null;
        if (item.variantId) {
          variant = product.variants.find(v => v._id?.toString() === item.variantId.toString());
        }

        if (!variant && (item.color || item.dimensions)) {
          variant = product.variants.find(
            (v) =>
              (!item.color || v.color?.toLowerCase() === item.color.toLowerCase()) &&
              (!item.dimensions || v.dimensions?.trim() === item.dimensions.trim())
          );
        }

        // If still no variant but product MUST have one, pick the first
        if (!variant) variant = product.variants[0];

        return {
          ...item,
          color: item.color || variant?.color || "",
          dimensions: item.dimensions || variant?.dimensions || "",
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
      paymentMethod: isPickup ? "PICKUP" : (isCOD ? "COD" : "CARD"),
      isPaid: !isCOD && !isPickup && !!paymentIntentId,
      paymentIntentId: paymentIntentId || undefined,
      paidAt: !isCOD && !isPickup && paymentIntentId ? new Date() : undefined,
      shipping: mergedShipping,
      contact: mergedContact,
      deliveryRegion: deliveryRegion || "Malta",
    });

    await order.save();
    // 🚨 Telegram instant notification

    await sendTelegramMessage(
      `🛒 <b>New Order</b>\n` +
      `Order ID: ${order._id}\n` +
      `Amount: €${order.finalTotal}\n` +
      `Payment: ${order.paymentMethod}\n` +
      `Customer: ${escapeHTML(mergedShipping.name)}\n` +
      `Time: ${new Date().toLocaleString()}`
    );

    // ✅ Mark coupon as used
    if (appliedCoupon) {
      appliedCoupon.usedAt = new Date();
      appliedCoupon.orderId = order._id;
      await appliedCoupon.save();
    }

    // 4️⃣ Decrement stock
    await adjustStock(fixedItems, "decrement");

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
router.get("/admin/orders", requireAdmin, async (_req, res) => {
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
router.put("/:orderId/status", requireAdmin, async (req, res) => {
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

    if (order.status !== "Cancelled" && status === "Cancelled") {
      await adjustStock(order.items, "increment");
      console.log(`Inventory restored for order ${order._id} (Admin Cancel)`);
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

    // Restore stock
    await adjustStock(order.items, "increment");

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
    const { items, total, paymentIntentId, guestInfo, couponCode, deliveryRegion, deliveryMethod } = req.body;

    // 🔒 SECURITY: PREVENT DUPLICATE ORDERS (Webhook vs Frontend Race)
    if (paymentIntentId) {
      const existing = await Order.findOne({ paymentIntentId });
      if (existing) {
        console.log(`ℹ️  Guest order for ${paymentIntentId} already exists. Skipping duplicate.`);
        return res.status(200).json(existing);
      }
    }

    if (
      !guestInfo ||
      !guestInfo.email ||
      !guestInfo.name ||
      !guestInfo.address
    ) {
      return res.status(400).json({ message: "Missing guest information" });
    }

    // 🔒 SECURITY: Block COD for guest checkout
    const guestIsCOD = paymentIntentId && String(paymentIntentId).startsWith("COD-");
    if (guestIsCOD) {
      return res.status(400).json({
        message: "Cash on Delivery is not available for guest checkout. Please pay with card."
      });
    }

    // 🔒 SECURITY: Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(guestInfo.email)) {
      return res.status(400).json({ message: "Invalid email address" });
    }

    // 🔒 SECURITY: Recalculate total for guest (NEVER trust client)
    let guestSubTotal = 0;
    for (const item of items) {
      const product = await Product.findById(item.product);
      if (product) {
        let price = product.price;
        if (item.color && item.dimensions && product.variants?.length) {
          const variant = product.variants.find(v =>
            v.color?.toLowerCase() === item.color?.toLowerCase() &&
            v.dimensions?.trim() === item.dimensions?.trim()
          );
          if (variant?.price) price = variant.price;
        }
        guestSubTotal += price * item.qty;
      }
    }

    let discountAmount = 0;
    let finalTotal = guestSubTotal;

    if (couponCode && String(couponCode).toUpperCase() === "TWAYBA5") {
      if (finalTotal >= 40) {
        const usedAlready = await Order.exists({
          "shipping.email": guestInfo.email,
          couponCode: "TWAYBA5",
          status: { $ne: "Cancelled" }
        });
        if (!usedAlready) {
          discountAmount = 5;
          finalTotal = Number((finalTotal - discountAmount).toFixed(2));
        }
      }
    } else if (couponCode && String(couponCode).toUpperCase().startsWith("WELCOME")) {
      discountAmount = Number((guestSubTotal * 0.05).toFixed(2));
    }

    /* -------------------------------------------------------
       🚚 Delivery Logic (Guest)
    ------------------------------------------------------- */
    let deliveryCharge = 0;
    const isGozo = deliveryRegion === "Gozo";
    if (isPickup || deliveryMethod === "Pickup") {
      deliveryCharge = 0;
    } else if (isGozo) {
      deliveryCharge = guestSubTotal >= 70 ? 0 : 10;
    } else {
      deliveryCharge = guestSubTotal >= 35 ? 0 : 5; // Malta tiered
    }

    finalTotal = Number((guestSubTotal - discountAmount + deliveryCharge).toFixed(2));

    const isCOD = paymentIntentId && String(paymentIntentId).startsWith("COD-");
    const isPickup = paymentIntentId && String(paymentIntentId).startsWith("PICKUP-");

    // 🔒 SECURITY: Verify Stripe (Guest) if not COD or Pickup
    if (!isCOD && !isPickup && paymentIntentId) {
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
      paymentMethod: isPickup ? "PICKUP" : (isCOD ? "COD" : "CARD"),
      isPaid: !isCOD && !isPickup && !!paymentIntentId,
      paymentIntentId: paymentIntentId || undefined,
      paidAt: !isCOD && !isPickup && paymentIntentId ? new Date() : undefined,
      shipping,
      contact,
      deliveryRegion: deliveryRegion || "Malta",
      deliveryMethod: deliveryMethod || "Shipping",
    });

    await order.save();

    // 4️⃣ Decrement stock
    await adjustStock(fixedItems, "decrement");

    // 🚨 Telegram instant notification for Guest
    try {
      await sendTelegramMessage(
        `🛒 <b>New Guest Order</b>\n` +
        `Order ID: ${order._id}\n` +
        `Amount: €${order.finalTotal}\n` +
        `Customer: ${escapeHTML(guestInfo.name)}\n` +
        `Time: ${new Date().toLocaleString()}`
      );
    } catch (e) {
      console.error("Guest Telegram error:", e.message);
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
