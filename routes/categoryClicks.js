import express from "express";
import CategoryClick from "../models/CategoryClick.js";

const router = express.Router();

// Increment category click count
router.patch("/:category", async (req, res) => {
  try {
    const updated = await CategoryClick.findOneAndUpdate(
      { category: req.params.category },
      { $inc: { count: 1 } },
      { upsert: true, new: true }
    );
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: "Failed to update category click" });
  }
});

// Get all category clicks
router.get("/", async (req, res) => {
  try {
    const all = await CategoryClick.find().sort({ count: -1 });
    res.json(all);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch clicks" });
  }
});

export default router;
