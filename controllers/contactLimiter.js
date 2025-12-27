// middleware/contactLimiter.js
import rateLimit, { ipKeyGenerator } from "express-rate-limit";

/**
 * Secure key generator for rate-limiting:
 * - Tries user ID or email (if logged in)
 * - Fallbacks to request body email
 * - Final fallback to IPv6-safe IP
 */
const secureKeyGenerator = (req) =>
  req.user?.id ||
  req.userId ||
  req.user?.email ||
  req.body?.email ||
  ipKeyGenerator(req); // ✅ SAFELY fallback to IP

export const contact15mLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 2,
  keyGenerator: secureKeyGenerator,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { message: "Too many messages. Try again in 15 minutes." },
});

export const contactDailyLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 10,
  keyGenerator: secureKeyGenerator,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    message: "Daily contact limit reached. Please try again tomorrow.",
  },
});
