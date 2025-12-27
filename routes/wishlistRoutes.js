// routes/wishlistRoutes.js
import express from "express";
import Wishlist from "../models/Wishlist.js";
import auth from "../middleware/auth.js";

const router = express.Router();

// Get wishlist
router.get("/", auth, async (req, res) => {
  let wl = await Wishlist.findOne({ user: req.userId }).populate(
    "items.product"
  );
  if (!wl) wl = await Wishlist.create({ user: req.userId, items: [] });
  res.json(wl.items);
});

// Add item to wishlist
router.post("/", auth, async (req, res) => {
  const { productId, color = null, dimensions = null } = req.body || {};
  if (!productId)
    return res.status(400).json({ message: "productId required" });

  let wl = await Wishlist.findOne({ user: req.userId });
  if (!wl) wl = await Wishlist.create({ user: req.userId, items: [] });

  const exists = wl.items.find(
    (i) =>
      i.product.toString() === productId &&
      (i.color || null) === (color || null) &&
      (i.dimensions || null) === (dimensions || null)
  );
  if (exists) {
    const populated = await wl.populate("items.product");
    return res.status(200).json({ added: false, items: populated.items });
  }

  wl.items.push({ product: productId, color, dimensions });
  await wl.save();
  const populated = await wl.populate("items.product");
  res.status(201).json({ added: true, items: populated.items });
});

// Remove item
router.delete("/", auth, async (req, res) => {
  const { productId, color = null, dimensions = null } = req.query || {};
  if (!productId)
    return res.status(400).json({ message: "productId required" });

  const wl = await Wishlist.findOneAndUpdate(
    { user: req.userId },
    { $pull: { items: { product: productId, color, dimensions } } },
    { new: true }
  ).populate("items.product");

  res.json({ removed: true, items: wl ? wl.items : [] });
});

// Clear all
router.delete("/all", auth, async (req, res) => {
  const wl = await Wishlist.findOneAndUpdate(
    { user: req.userId },
    { $set: { items: [] } },
    { new: true }
  );
  res.json({ cleared: true, items: [] });
});

export default router;
