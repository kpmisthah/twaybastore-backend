// routes/userRoutes.js
import express from "express";
import User from "../models/User.js";
import auth from "../middleware/auth.js"; // ✅ Import the middleware

const router = express.Router();

/* --------------------------------------------------------
   GET: All Users (Admin Dashboard)
-------------------------------------------------------- */
router.get("/", async (req, res) => {
  try {
    const users = await User.find().sort({ createdAt: -1 });
    res.json(users);
  } catch (err) {
    console.error("Error fetching users:", err);
    res.status(500).json({ message: "Failed to fetch users." });
  }
});

/* --------------------------------------------------------
   GET: Current User Ban Status (Frontend Check)
   🔒 Protected route (requires JWT)
-------------------------------------------------------- */
router.get("/status/me", auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    res.json({
      isBanned: user.isBanned,
      banReason: user.banReason,
      bannedAt: user.bannedAt,
    });
  } catch (err) {
    console.error("Error checking ban status:", err);
    res.status(500).json({ message: "Failed to fetch user status" });
  }
});

/* --------------------------------------------------------
   PUT: Ban User (Admin Action)
-------------------------------------------------------- */
router.put("/ban/:id", async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason)
      return res.status(400).json({ message: "Ban reason is required." });

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: "User not found." });

    if (user.isBanned)
      return res.status(400).json({ message: "User already banned." });

    user.isBanned = true;
    user.banReason = reason;
    user.bannedAt = new Date();
    await user.save();

    // ✅ Send email notification
    try {
      const { sendBanNotification } = await import("../utils/mailer.js");
      await sendBanNotification({
        to: user.email,
        userName: user.name,
        reason,
      });
      console.log(`✅ Ban email sent to ${user.email}`);
    } catch (err) {
      console.error("❌ Failed to send ban email:", err);
    }

    res.json({ message: "User banned successfully and notified via email.", user });
  } catch (err) {
    console.error("Error banning user:", err);
    res.status(500).json({ message: "Failed to ban user." });
  }
});
/* --------------------------------------------------------
   PUT: Unban User (Admin Action)
-------------------------------------------------------- */
router.put("/unban/:id", async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: "User not found." });

    user.isBanned = false;
    user.banReason = "";
    user.bannedAt = null;
    await user.save();

    res.json({ message: "User unbanned successfully.", user });
  } catch (err) {
    console.error("Error unbanning user:", err);
    res.status(500).json({ message: "Failed to unban user." });
  }
});

export default router;