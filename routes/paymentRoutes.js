import express from "express";
import stripe from "../config/stripe.js";

const router = express.Router();

// 1. Create PaymentIntent
router.post("/create-payment", async (req, res) => {
  try {
    const { amount, currency = "eur" } = req.body;
    // Debug: print received data
    console.log("Received payment intent request:", amount, currency);

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency,
    });
    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
    });
  } catch (err) {
    console.error("Stripe PaymentIntent error:", err); // << PRINTS FULL ERROR!
    res.status(500).json({
      error: "Failed to create Stripe payment intent",
      details: err.message,
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
