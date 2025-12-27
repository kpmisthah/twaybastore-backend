// routes/analytics.js
import express from "express";
import Order from "../models/Order.js";
import Product from "../models/Product.js";
import VoiceSearch from "../models/VoiceSearch.js";
import SearchEvent from "../models/SearchEvent.js";
import Visit from "../models/Visit.js";
import User from "../models/User.js";
import { sendProductViewMail } from "../utils/mailer.js";
import mongoose from "mongoose";

// import authOptional from "../middleware/authOptional.js";

const router = express.Router();

/* -------------------------- POST /analytics/search -------------------------- */
/**
 * Body: { query, type: "text" | "voice", pathname?, ua?, lang?, confidence?, tookMs?, error?, message? }
 * Tags availability: "HAS_PRODUCT" | "NO_PRODUCT", then persists to Mongo.
 */

router.get("/product-sales/:productId", async (req, res) => {
  try {
    const { productId } = req.params;

    // Aggregate all orders containing this product
    const pipeline = [
      { $unwind: "$items" },
      { $match: { "items.product": new mongoose.Types.ObjectId(productId) } },
      {
        $group: {
          _id: "$items.product",
          totalSold: { $sum: { $ifNull: ["$items.qty", 1] } },
        },
      },
    ];

    const result = await Order.aggregate(pipeline);

    const totalSold = result.length > 0 ? result[0].totalSold : 0;

    res.json({ productId, totalSold });
  } catch (err) {
    console.error("Error fetching product sales:", err);
    res.status(500).json({ message: "Failed to fetch product sales." });
  }
});

router.post(
  "/search",
  /* authOptional, */ async (req, res) => {
    const started = Date.now();
    try {
      const {
        query,
        type, // "text" | "voice"
        pathname,
        ua,
        lang,
        confidence,
        tookMs,
        error,
        message,
      } = req.body || {};

      // Visibility while integrating:
      console.log("[/analytics/search] incoming", {
        query,
        type,
        pathname,
        hasError: !!error,
      });

      if (!query && !error) {
        return res.status(400).json({ ok: false, message: "No query to log." });
      }

      // Availability check — fully guarded so it can never block inserts.
      let count = 0;
      try {
        if (query) {
          // If you created a text index, switch to:
          // count = await Product.countDocuments({ $text: { $search: query } });
          count = await Product.countDocuments({
            name: { $regex: query, $options: "i" },
          });
        }
      } catch (e) {
        console.error(
          "[/analytics/search] availability check failed:",
          e?.message
        );
        // keep count = 0
      }

      const availabilityTag = count > 0 ? "HAS_PRODUCT" : "NO_PRODUCT";
      const ip =
        req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
        req.socket?.remoteAddress ||
        req.ip;

      // Persist (and log result id so you can see it in logs)
      const doc = await SearchEvent.create({
        user: req.user?._id,
        query,
        type: type || "text",
        availabilityTag,
        count,
        pathname,
        ua,
        lang,
        confidence,
        tookMs: tookMs ?? Date.now() - started,
        error,
        message,
        ip,
      });

      console.log("[/analytics/search] stored", {
        id: doc._id,
        availabilityTag,
        count,
      });

      return res
        .status(201)
        .json({ ok: true, id: doc._id, availabilityTag, count });
    } catch (e) {
      console.error("analytics/search failed:", e);
      return res
        .status(500)
        .json({ ok: false, message: "Failed to log search event" });
    }
  }
);

// product reminder 


router.post("/product-view", async (req, res) => {
  try {
    const { userId, productId } = req.body;
    if (!userId || !productId) {
      return res.status(400).json({ success: false, message: "Missing userId or productId" });
    }

    const user = await User.findById(userId).lean();
    const product = await Product.findById(productId).lean();

    if (!user || !product) {
      return res.status(404).json({ success: false, message: "User or product not found" });
    }

    // send email
    await sendProductViewMail({
      to: user.email,
      userName: user.name || "Customer",
      product,
    });

    return res.json({ success: true, message: "Product reminder email sent" });
  } catch (err) {
    console.error("Error sending product-view email:", err);
    res.status(500).json({ success: false, message: "Failed to send product view email" });
  }
});


/* ----------------------- POST /analytics/voice-search ----------------------- */
router.post(
  "/voice-search",
  /* authOptional, */ async (req, res) => {
    try {
      const {
        transcript,
        confidence,
        lang,
        source,
        pathname,
        ua,
        tookMs,
        error,
        message,
      } = req.body || {};

      if (!transcript && !error) {
        return res.status(400).json({ ok: false, message: "Nothing to log." });
      }

      const ip =
        req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
        req.socket?.remoteAddress ||
        req.ip;

      const doc = await VoiceSearch.create({
        user: req.user?._id || undefined,
        transcript,
        confidence,
        lang,
        source,
        pathname,
        ua,
        tookMs,
        error,
        message,
        ip,
      });

      console.log("[/analytics/voice-search] stored", { id: doc._id });

      return res.status(201).json({ ok: true, id: doc._id });
    } catch (e) {
      console.error("voice-search log failed", e);
      return res
        .status(500)
        .json({ ok: false, message: "Failed to log voice search" });
    }
  }
);

/* ------------------------ GET /analytics/voice-search ----------------------- */
router.get("/voice-search", async (req, res) => {
  try {
    const {
      from,
      to,
      q,
      page = 1,
      limit = 20,
      source,
      userId,
      hasError, // "true" to filter only errors
    } = req.query;

    const lim = Math.min(parseInt(limit, 10) || 20, 200);
    const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * lim;

    const filter = {};
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) filter.createdAt.$lte = new Date(to);
    }
    if (source) filter.source = source;
    if (userId) filter.user = userId;
    if (hasError === "true") filter.error = { $exists: true, $ne: null };
    if (q) filter.$text = { $search: q };

    const [items, total] = await Promise.all([
      VoiceSearch.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(lim)
        .lean(),
      VoiceSearch.countDocuments(filter),
    ]);

    res.json({ ok: true, page: Number(page), limit: lim, total, items });
  } catch (e) {
    console.error("voice-search list failed", e);
    res
      .status(500)
      .json({ ok: false, message: "Failed to fetch voice searches" });
  }
});

/* -------------------------- GET /analytics/search --------------------------- */
/** Quick admin peek at recent search events: ?limit=20 */
router.get("/search", async (req, res) => {
  try {
    const lim = Math.min(parseInt(req.query.limit, 10) || 20, 200);
    const items = await SearchEvent.find({})
      .sort({ createdAt: -1 })
      .limit(lim)
      .lean();
    res.json({ ok: true, items });
  } catch (e) {
    console.error("GET /analytics/search failed:", e);
    res.status(500).json({ ok: false, message: "Failed to fetch search events" });
  }
});

/* ----------------------- GET /analytics/top-products ------------------------ */
router.get("/top-products", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 12, 50);

    const pipeline = [
      { $unwind: "$items" },
      { $match: { "items.product": { $ne: null } } },
      {
        $group: {
          _id: "$items.product",
          totalSold: { $sum: { $ifNull: ["$items.qty", 1] } },
        },
      },
      { $sort: { totalSold: -1 } },
      { $limit: limit },
      {
        $lookup: {
          from: "products",
          localField: "_id",
          foreignField: "_id",
          as: "product",
        },
      },
      { $unwind: "$product" },
      {
        $project: {
          _id: 0,
          productId: "$product._id",
          name: "$product.name",
          price: "$product.price",
          realPrice: "$product.realPrice",
          discount: "$product.discount",
          images: "$product.images",
          description: "$product.description",
          totalSold: 1,
        },
      },
    ];

    const results = await Order.aggregate(pipeline);
    res.json(results);
  } catch (err) {
    console.error("Top products error:", err);
    res.status(500).json({ message: "Failed to fetch top products" });
  }
});





router.post("/track", async (req, res) => {
  try {
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
    const { path } = req.body;

    await Visit.create({
      ip,
      userAgent: req.headers["user-agent"],
      path,
      timestamp: new Date(),
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Track error:", err);
    res.status(500).json({ error: "Failed to track visit" });
  }
});

// Get overall stats
router.get("/stats", async (req, res) => {
  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const last30Days = new Date();
    last30Days.setDate(last30Days.getDate() - 30);

    const [live, today, last30, all] = await Promise.all([
      Visit.countDocuments({ timestamp: { $gte: new Date(Date.now() - 5 * 60 * 1000) } }),
      Visit.countDocuments({ timestamp: { $gte: todayStart } }),
      Visit.countDocuments({ timestamp: { $gte: last30Days } }),
      Visit.countDocuments(),
    ]);

    res.json({ live, today, last30, all });
  } catch (err) {
    console.error("Stats error:", err);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

// 👇 NEW: group by path
router.get("/pages", async (req, res) => {
  try {
    const results = await Visit.aggregate([
      { $group: { _id: "$path", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);

    res.json(results); // e.g. [ { _id: "/contact", count: 23 }, { _id: "/about", count: 10 } ]
  } catch (err) {
    console.error("Pages stats error:", err);
    res.status(500).json({ error: "Failed to fetch page stats" });
  }
});


export default router;
