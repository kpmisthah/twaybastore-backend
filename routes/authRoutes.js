import express from "express";
import authMiddleware from "../middleware/auth.js";
import {
  signup,
  verifyOtp,
  resendOtp,
  login,
  requestPasswordReset,
  resetPassword,
  // sendWelcomeGift, // ✅ Added
} from "../controllers/authController.js";
import User from "../models/User.js";

const router = express.Router();

/* -------------------------------------------
   Profile completeness helpers (for /me)
------------------------------------------- */
const REQUIRED_FIELDS = ["email", "street", "city", "area", "zipCode", "mobile", "fullName"];
const getMissing = (u) =>
  REQUIRED_FIELDS.filter((f) => !u?.[f] || String(u[f]).trim() === "");

/* -------------------------------------------
   Auth core
------------------------------------------- */
router.post("/signup", signup);
router.post("/verify-otp", verifyOtp);
router.post("/resend-otp", resendOtp);
router.post("/login", login);

/* -------------------------------------------
   Password reset via email OTP
------------------------------------------- */
router.post("/request-password-reset", requestPasswordReset);
router.post("/reset-password", resetPassword);

/* -------------------------------------------
   Welcome gift route (5% off code within 24h)
------------------------------------------- */
// router.post("/send-welcome-gift", authMiddleware, sendWelcomeGift); // ✅ Added

/* -------------------------------------------
   Me (profile)
------------------------------------------- */
router.get("/me", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select(
      "-password -otpHash -otpExpiresAt -__v"
    );
    if (!user) return res.status(404).json({ message: "User not found" });

    const missingFields = getMissing(user);
    return res.status(200).json({
      user,
      isProfileComplete: missingFields.length === 0,
      missingFields,
    });
  } catch (err) {
    console.error("GET /me error:", err);
    return res.status(500).json({ message: "Failed to fetch profile" });
  }
});

router.put("/me", authMiddleware, async (req, res) => {
  try {
    const { email, secondPhone, street, city, area, zipCode } = req.body;

    if (email) {
      const exists = await User.findOne({ email, _id: { $ne: req.user.id } });
      if (exists) return res.status(400).json({ message: "Email already in use" });
    }

    const user = await User.findByIdAndUpdate(
      req.user.id,
      { email, secondPhone, street, city, area, zipCode },
      { new: true, runValidators: true }
    ).select("-password -otpHash -otpExpiresAt -__v");

    if (!user) return res.status(404).json({ message: "User not found" });

    const missingFields = getMissing(user);
    return res.json({
      user,
      isProfileComplete: missingFields.length === 0,
      missingFields,
    });
  } catch (err) {
    console.error("PUT /me error:", err);
    return res.status(500).json({ message: "Failed to update profile" });
  }
});

export default router;
