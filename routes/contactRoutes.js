import express from "express";
import auth from "../middleware/auth.js";
import { sendContact } from "../controllers/contactController.js";
import { contact15mLimiter, contactDailyLimiter } from "../controllers/contactLimiter.js";

const router = express.Router();

// Optional login middleware (don’t block if no token)
const softAuth = async (req, res, next) => {
  try {
    await auth(req, res, () => {});
  } catch (_) {}
  next();
};

router.post(
  "/",
  contact15mLimiter,
  contactDailyLimiter,
  softAuth,
  sendContact
);

export default router;
