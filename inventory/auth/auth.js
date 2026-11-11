// inventory/auth/auth.js — staff login tokens and the guards every inventory route uses.
import { createHmac } from "node:crypto";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import { forbidden, unauthorized } from "../lib/http.js";

/**
 * Inventory tokens carry their own audience, so a website customer token or website-admin
 * token (signed with other settings) is never accepted here, and vice versa.
 */
const AUDIENCE = "twayba-inventory";

function secret() {
  if (process.env.INVENTORY_JWT_SECRET) return process.env.INVENTORY_JWT_SECRET;
  // Never sign with the website's own key: an inventory token must not verify as a customer token.
  if (process.env.JWT_SECRET) return createHmac("sha256", process.env.JWT_SECRET).update("twayba-inventory").digest("hex");
  throw new Error("Set INVENTORY_JWT_SECRET (or JWT_SECRET) to use the inventory API");
}

export function signToken(user) {
  return jwt.sign({ sub: String(user._id), role: user.role }, secret(), {
    audience: AUDIENCE,
    expiresIn: process.env.INVENTORY_JWT_EXPIRES_IN || "12h",
  });
}

/**
 * Every route needs a valid Bearer token. The user is re-loaded on each request so
 * deactivated accounts and role changes take effect immediately, not when the token expires.
 */
export async function requireStaff(req, res, next) {
  try {
    const [type, token] = (req.headers.authorization || "").split(" ");
    if (type !== "Bearer" || !token) throw unauthorized();

    let payload;
    try {
      payload = jwt.verify(token, secret(), { audience: AUDIENCE });
    } catch {
      throw unauthorized("Session expired, please log in again");
    }

    const user = await User.findById(payload.sub).select("name email phone role active siteIds").lean();
    if (!user || !user.active) throw unauthorized("Account disabled");

    req.staff = {
      id: String(user._id),
      name: user.name,
      email: user.email ?? null,
      phone: user.phone ?? null,
      role: user.role,
      siteIds: (user.siteIds || []).map(String),
    };
    next();
  } catch (err) {
    next(err);
  }
}

/** Route guard: only these roles. */
export const allow =
  (...roles) =>
  (req, res, next) => {
    if (!req.staff || !roles.flat().includes(req.staff.role)) return next(forbidden());
    next();
  };
