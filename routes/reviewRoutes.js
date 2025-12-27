import express from "express";
import Review from "../models/Review.js";
import Order from "../models/Order.js";
import auth from "../middleware/auth.js";
import mongoose from "mongoose";

const router = express.Router();

// 1. Get reviews for a product (with user fullName)
router.get("/products/:id/reviews", async (req, res) => {
  try {
    const reviews = await Review.find({ product: req.params.id })
      .populate("user", "fullName")
      .sort({ createdAt: -1 });
    res.json(reviews);
  } catch (e) {
    res
      .status(500)
      .json({ message: "Failed to load reviews", error: e.message });
  }
});

// DEBUG: Get any one review + its user object
router.get("/debug/review-sample", async (req, res) => {
  const review = await Review.findOne().populate("user", "fullName email name");
  res.json(review);
});

// 2. (Optional) Get review eligibility for user
router.get("/products/:id/review-eligibility", auth, async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user._id);
    const productId = new mongoose.Types.ObjectId(req.params.id);

    const alreadyReviewed = await Review.exists({
      product: productId,
      user: userId,
    });
    if (alreadyReviewed)
      return res.json({ canReview: false, reason: "already_reviewed" });

    const hasDelivered = await Order.exists({
      user: userId,
      "items.product": productId,
      status: "Delivered",
    });

    return res.json({
      canReview: !!hasDelivered,
      reason: hasDelivered ? null : "not_delivered",
    });
  } catch (e) {
    res.status(500).json({ canReview: false, error: e.message });
  }
});

router.post("/products/:id/reviews", auth, async (req, res) => {
  try {
    const { rating, comment, image } = req.body;
    const userId = new mongoose.Types.ObjectId(req.user._id || req.user.id);
    const productId = new mongoose.Types.ObjectId(req.params.id);

    // 1. Only allow review if order is delivered for this product
    const hasDelivered = await Order.exists({
      user: userId,
      "items.product": productId,
      status: "Delivered"
    });

    if (!hasDelivered) {
      return res.status(403).json({ message: "You can only review products you have purchased and received." });
    }

    // 2. Prevent duplicate review by same user for same product
    const alreadyReviewed = await Review.exists({
      product: productId,
      user: userId,
    });
    if (alreadyReviewed)
      return res
        .status(400)
        .json({ message: "You already reviewed this product." });

    // 3. Create the review (now always a verified buyer!)
    let review = await Review.create({
      product: productId,
      user: userId,
      rating,
      comment,
      image,
      isVerifiedBuyer: true, // Always true if passed!
    });

    review = await review.populate("user", "fullName");

    res.status(201).json(review);
  } catch (e) {
    res
      .status(500)
      .json({ message: "Failed to submit review.", error: e.message });
  }
});

// 4. Admin delete review
router.delete("/reviews/:reviewId", auth, async (req, res) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ message: "Forbidden" });
  }
  await Review.findByIdAndDelete(req.params.reviewId);
  res.json({ success: true });
});

export default router;
