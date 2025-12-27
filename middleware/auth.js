import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import User from "../models/User.js";
import BannedIP from "../models/BannedIP.js";

dotenv.config();

function getClientIP(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    req.socket.remoteAddress ||
    req.connection.remoteAddress ||
    "unknown"
  );
}

export default async function auth(req, res, next) {
  try {
    const ip = getClientIP(req);

    // 🚫 1. Check if IP is banned
    const ipBan = await BannedIP.findOne({ ip });
    if (ipBan) {
      return res.status(403).json({
        banned: true,
        type: "ip",
        reason: ipBan.reason,
        message: "Access denied. Your IP has been banned.",
      });
    }

    // ✅ 2. Continue with normal JWT + user ban check
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.split(" ")[1]
      : req.cookies?.token;

    if (!token) return res.status(401).json({ message: "Unauthorized" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    // 🚫 3. Check user ban
    if (user.isBanned) {
      return res.status(403).json({
        banned: true,
        type: "user",
        reason: user.banReason || "Policy violation",
        message: "Your account has been banned.",
      });
    }

    req.userId = user._id;
    req.user = user;
    next();
  } catch (err) {
    console.error("Auth middleware error:", err);
    res.status(401).json({ message: "Unauthorized" });
  }
}
