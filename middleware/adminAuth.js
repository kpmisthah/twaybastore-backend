// middleware/adminAuth.js
import { verifyAccess } from "../utils/jwt.js";

export function requireAdmin(req, res, next) {
  try {
    const hdr = req.headers.authorization || "";
    const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;
    if (!token) return res.status(401).json({ message: "Unauthorized" });

    const payload = verifyAccess(token);
    if (payload.role !== "admin") {
      return res.status(403).json({ message: "Admins only" });
    }
    req.admin = payload;
    next();
  } catch {
    return res.status(401).json({ message: "Unauthorized" });
  }
}
