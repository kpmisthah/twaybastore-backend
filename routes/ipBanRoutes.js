// routes/ipBanRoutes.js
import express from "express";
import BannedIP from "../models/BannedIP.js";

const router = express.Router();

// Ban IP
router.post("/ban", async (req, res) => {
  try {
    const { ip, reason } = req.body;
    if (!ip) return res.status(400).json({ message: "IP address is required." });

    const existing = await BannedIP.findOne({ ip });
    if (existing) return res.status(400).json({ message: "IP already banned." });

    await BannedIP.create({ ip, reason });
    res.json({ message: "IP banned successfully." });
  } catch (err) {
    console.error("Error banning IP:", err);
    res.status(500).json({ message: "Failed to ban IP." });
  }
});

// Unban IP
router.delete("/unban/:ip", async (req, res) => {
  try {
    await BannedIP.findOneAndDelete({ ip: req.params.ip });
    res.json({ message: "IP unbanned successfully." });
  } catch (err) {
    console.error("Error unbanning IP:", err);
    res.status(500).json({ message: "Failed to unban IP." });
  }
});

export default router;
