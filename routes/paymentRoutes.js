import express from "express";
import stripe from "../config/stripe.js";
import Product from "../models/Product.js";
import Coupon from "../models/Coupon.js";
import Order from "../models/Order.js";
import { paymentRateLimiter } from "../middleware/rateLimiter.js";

const router = express.Router();

// 1. Create PaymentIntent (SECURE with Idempotency)
router.post("/create-payment", paymentRateLimiter, async (req, res) => {
  try {
    const { items, currency = "eur", couponCode, userId, guestInfo } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "No items provided" });
    }

    // 1. Calculate Subtotal from Database (NEVER trust client)
    let subTotal = 0;
    const productDetails = [];

    for (const item of items) {
      if (!item.product || !item.qty || item.qty <= 0) {
        return res.status(400).json({
          error: "Invalid item data",
          details: "Each item must have product ID and positive quantity"
        });
      }

      const product = await Product.findById(item.product);
      if (!product) {
        return res.status(400).json({
          error: `Product not found: ${item.product}`
        });
      }

      let price = product.price;

      // Check for variant specific price
      if (item.color && item.dimensions && product.variants?.length) {
        const variant = product.variants.find(
          (v) =>
            v.color?.toLowerCase() === item.color?.toLowerCase() &&
            v.dimensions?.trim() === item.dimensions?.trim()
        );
        if (variant && variant.price) {
          price = variant.price;
        }
      }

      const itemTotal = price * item.qty;
      subTotal += itemTotal;

      productDetails.push({
        productId: item.product,
        name: product.name,
        price,
        qty: item.qty,
        total: itemTotal
      });
    }

    // Validate minimum amount
    if (subTotal <= 0) {
      return res.status(400).json({
        error: "Invalid order total",
        details: "Order total must be greater than 0"
      });
    }

    // 2. Apply Coupon Logic (Matching Order Routes)
    let discountAmount = 0;

    // Logic A: Logged In User Coupon
    if (couponCode && userId) {
      const coupon = await Coupon.findOne({ code: couponCode, userId });
      // Check if coupon is valid
      if (
        coupon &&
        !coupon.usedAt &&
        coupon.expiresAt > new Date() &&
        coupon.reason === "WELCOME_NEW_USER"
      ) {
        // Check if user has previous orders
        const hasOrders = await Order.exists({ user: userId });
        if (!hasOrders) {
          discountAmount = (subTotal * coupon.value) / 100;
        }
      }
    }
    // Logic B: Guest "WELCOME" Coupon (hardcoded 5%)
    else if (couponCode && String(couponCode).toUpperCase().startsWith("WELCOME")) {
      // Guest logic from orderRoutes: 5% discount
      discountAmount = subTotal * 0.05;
    }

    let finalTotal = subTotal - discountAmount;

    // Ensure at least 50 cents for Stripe (minimum charge amount)
    if (finalTotal < 0.50) {
      return res.status(400).json({
        error: "Order total too low",
        details: "Minimum order amount is €0.50"
      });
    }

    // Round to 2 decimal places to avoid floating point issues
    finalTotal = Math.round(finalTotal * 100) / 100;

    // 3. Generate idempotency key to prevent duplicate charges
    const idempotencyKey = `payment_${userId || 'guest'}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // 4. Create Stripe Payment Intent
    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: Math.round(finalTotal * 100), // Convert to cents
        currency,
        metadata: {
          userId: userId || 'guest',
          couponCode: couponCode || 'none',
          itemCount: items.length,
          subtotal: subTotal.toFixed(2),
          discount: discountAmount.toFixed(2),
        },
        description: `Order for ${productDetails.length} item(s)`,
        // Enable automatic payment methods
        automatic_payment_methods: {
          enabled: true,
        },
      },
      {
        idempotencyKey, // Prevents duplicate charges if request is retried
      }
    );

    // Log for debugging (only in development)
    if (process.env.NODE_ENV !== "production") {
      console.log(`Payment Intent Created: ${paymentIntent.id}`);
      console.log(`Items: ${items.length}, Subtotal: €${subTotal}, Discount: €${discountAmount}, Final: €${finalTotal}`);
    }

    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      amount: finalTotal,
      subtotal: subTotal,
      discount: discountAmount,
      idempotencyKey, // Send back for order creation
    });
  } catch (err) {
    console.error("Stripe PaymentIntent error:", err);

    // Provide user-friendly error messages
    let errorMessage = "Failed to create payment intent";
    let statusCode = 500;

    if (err.type === "StripeCardError") {
      errorMessage = err.message;
      statusCode = 400;
    } else if (err.type === "StripeInvalidRequestError") {
      errorMessage = "Invalid payment request";
      statusCode = 400;
    } else if (err.type === "StripeAPIError") {
      errorMessage = "Payment service temporarily unavailable";
      statusCode = 503;
    }

    res.status(statusCode).json({
      error: errorMessage,
      details: process.env.NODE_ENV !== "production" ? err.message : undefined,
    });
  }
});

// 2. Optionally verify payment status by PaymentIntent ID (not usually required)
router.get("/verify-payment/:paymentIntentId", async (req, res) => {
  const { paymentIntentId } = req.params;
  try {
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (paymentIntent.status === "succeeded") {
      return res.json({ success: true, paymentIntent });
    }
    return res.json({
      success: false,
      status: paymentIntent.status,
      paymentIntent,
    });
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message });
  }
});

export default router;
