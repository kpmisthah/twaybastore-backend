import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import User from "../models/User.js";
// import Coupon from "../models/Coupon.js"; // ✅ Added
import { sendOtpEmail } from "../utils/mailer.js";
import { sendWelcomeEmail } from "../utils/mailer.js";
// import { sendWelcomeGiftEmail } from "../utils/mailer.js";

const generateOTP = () =>
  Math.floor(100000 + Math.random() * 900000).toString();
const hash = (str) => crypto.createHash("sha256").update(str).digest("hex");
const OTP_TTL_MIN = 10;

/* ---------------------- Signup ---------------------- */
export const signup = async (req, res) => {
  try {
    const { fullName, email, password, mobile, sendAdsEmail = true } = req.body;

    if (!fullName || !email || !password) {
      return res
        .status(400)
        .json({ message: "Full name, email, and password are required" });
    }

    const existing = await User.findOne({ email });
    if (existing)
      return res
        .status(400)
        .json({ message: "User already exists with this email" });

    const hashedPassword = await bcrypt.hash(password, 10);
    const otp = generateOTP();

    const user = await User.create({
      fullName,
      email,
      mobile: mobile || "",
      password: hashedPassword,
      sendAdsEmail,
      otpHash: hash(otp),
      otpExpiresAt: new Date(Date.now() + OTP_TTL_MIN * 60 * 1000),
      isVerified: false,
    });

    await sendOtpEmail(email, otp, "Email Verification");

    console.log("✅ New user signup:", {
      fullName,
      email,
      mobile,
      sendAdsEmail,
    });

    const createdUser = await User.findById(user._id).lean();
    console.log("✅ Stored in DB:", createdUser);

    return res.status(201).json({
      message: "Signup successful. OTP sent to your email.",
      userId: user._id,
    });
  } catch (err) {
    console.error("❌ Signup error:", err);
    return res.status(500).json({ message: "Server error during signup" });
  }
};

/* ---------------------- Verify OTP ---------------------- */
export const verifyOtp = async (req, res) => {
  try {
    const { userId, otp } = req.body;
    if (!userId || !otp)
      return res.status(400).json({ message: "userId and otp are required" });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    if (!user.otpHash || !user.otpExpiresAt)
      return res.status(400).json({ message: "No OTP pending for this user" });
    if (user.otpExpiresAt < new Date())
      return res.status(400).json({ message: "OTP expired" });
    if (user.otpHash !== hash(otp))
      return res.status(400).json({ message: "Invalid OTP" });

    user.isVerified = true;
    user.otpHash = null;
    user.otpExpiresAt = null;
    await user.save();

    // ✅ Send welcome email automatically
    try {
      await sendWelcomeEmail({
        to: user.email,
        userName: user.fullName || user.email.split("@")[0],
      });
      console.log(`✅ Welcome email sent to ${user.email}`);
    } catch (err) {
      console.error("❌ Welcome email send error:", err.message);
    }

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    return res.status(200).json({
      message: "OTP verified successfully",
      token,
      user: {
        _id: user._id,
        fullName: user.fullName,
        email: user.email,
        mobile: user.mobile,
      },
    });
  } catch (err) {
    console.error("❌ OTP verification error:", err);
    return res.status(500).json({ message: "Error verifying OTP" });
  }
};


/* ---------------------- Resend OTP ---------------------- */
export const resendOtp = async (req, res) => {
  try {
    const { userId, email } = req.body;
    const user = userId
      ? await User.findById(userId)
      : await User.findOne({ email });

    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.isVerified)
      return res.status(400).json({ message: "User already verified" });

    const otp = generateOTP();
    user.otpHash = hash(otp);
    user.otpExpiresAt = new Date(Date.now() + OTP_TTL_MIN * 60 * 1000);
    await user.save();

    await sendOtpEmail(user.email, otp, "Email Verification");

    return res.json({ message: "OTP resent to your email", userId: user._id });
  } catch (err) {
    console.error("❌ Resend OTP error:", err);
    return res.status(500).json({ message: "Server error during resend OTP" });
  }
};

/* ---------------------- Request Password Reset ---------------------- */
export const requestPasswordReset = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: "Email is required" });

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: "User not found" });

    const otp = generateOTP();
    user.otpHash = hash(otp);
    user.otpExpiresAt = new Date(Date.now() + OTP_TTL_MIN * 60 * 1000);
    await user.save();

    await sendOtpEmail(email, otp, "Password Reset");

    return res.json({ message: "OTP sent to your email", userId: user._id });
  } catch (err) {
    console.error("❌ Password reset OTP error:", err);
    return res
      .status(500)
      .json({ message: "Server error during password reset OTP" });
  }
};

/* ---------------------- Reset Password ---------------------- */
export const resetPassword = async (req, res) => {
  try {
    const { userId, otp, newPassword } = req.body;
    if (!userId || !otp || !newPassword) {
      return res
        .status(400)
        .json({ message: "userId, otp, and newPassword are required" });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    if (!user.otpHash || !user.otpExpiresAt) {
      return res.status(400).json({ message: "No OTP pending for this user" });
    }
    if (user.otpExpiresAt < new Date())
      return res.status(400).json({ message: "OTP expired" });
    if (user.otpHash !== hash(otp))
      return res.status(400).json({ message: "Invalid OTP" });

    user.password = await bcrypt.hash(newPassword, 10);
    user.otpHash = null;
    user.otpExpiresAt = null;
    await user.save();

    return res.json({ message: "Password reset successfully" });
  } catch (err) {
    console.error("❌ Password reset error:", err);
    return res
      .status(500)
      .json({ message: "Server error during password reset" });
  }
};

/* ---------------------- Login ---------------------- */
export const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: "User not found" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: "Invalid password" });

    if (!user.isVerified) {
      return res
        .status(403)
        .json({ message: "Please verify your email to continue" });
    }

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    return res.status(200).json({
      message: "Login successful",
      token,
      user: {
        _id: user._id,
        fullName: user.fullName,
        email: user.email,
        mobile: user.mobile,
      },
    });
  } catch (err) {
    console.error("❌ Login error:", err);
    return res.status(500).json({ message: "Server error during login" });
  }
};

/* ---------------------- Send Welcome Gift Code (Manual Re-send) ---------------------- */
// export const sendWelcomeGift = async (req, res) => {
//   try {
//     const userId = req.userId;
//     if (!userId) return res.status(400).json({ message: "Missing user ID" });

//     const user = await User.findById(userId);
//     if (!user) return res.status(404).json({ message: "User not found" });

//     const existingCoupon = await Coupon.findOne({
//       userId,
//       reason: "WELCOME_NEW_USER",
//       expiresAt: { $gt: new Date() },
//     });
//     if (existingCoupon)
//       return res.status(400).json({ message: "Gift code already sent." });

//     const code = `WELCOME${Math.floor(100000 + Math.random() * 900000)}`;
//     const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

//     const coupon = new Coupon({
//       code,
//       userId,
//       value: 5,
//       discountType: "percent",
//       expiresAt,
//       reason: "WELCOME_NEW_USER",
//     });
//     await coupon.save();

//     await sendWelcomeGiftEmail({
//       to: user.email,
//       userName: user.fullName,
//       code,
//       expiresAt,
//     });

//     return res.json({ message: "Gift email sent successfully" });
//   } catch (err) {
//     console.error("❌ Gift email error:", err);
//     return res.status(500).json({ message: "Failed to send gift email" });
//   }
// };
