// controllers/adminAuthController.js
import Admin from "../models/Admin.js";
import { signAccessToken } from "../utils/jwt.js";

// ------------------ REGISTER ------------------
export async function adminRegister(req, res) {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ message: "All fields are required" });
    }

    const existing = await Admin.findOne({ email });
    if (existing) {
      return res.status(400).json({ message: "Admin already exists with this email" });
    }

    const admin = new Admin({ username, email, password });
    await admin.save();

    return res.status(201).json({
      message: "Admin account created",
      admin: {
        id: admin._id,
        username: admin.username,
        email: admin.email,
        role: admin.role,
      },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Server error" });
  }
}

// ------------------ LOGIN ------------------
export async function adminLogin(req, res) {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ message: "Email and password required" });

  const admin = await Admin.findOne({ email }).select("+password");
  if (!admin) return res.status(401).json({ message: "Invalid credentials" });

  const ok = await admin.comparePassword(password);
  if (!ok) return res.status(401).json({ message: "Invalid credentials" });

  const payload = { id: admin._id.toString(), email: admin.email, role: "admin" };
  const token = signAccessToken(payload);

  const safeAdmin = {
    id: admin._id,
    username: admin.username,
    email: admin.email,
    role: "admin",
  };

  return res.json({ token, admin: safeAdmin });
}
