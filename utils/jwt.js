// utils/jwt.js
import jwt from "jsonwebtoken";

const {
  JWT_ACCESS_SECRET = "supersecret_access",
  JWT_REFRESH_SECRET = "supersecret_refresh",
  JWT_ACCESS_TTL = "15m",
  JWT_REFRESH_TTL = "7d",
} = process.env;

export function signAccessToken(payload) {
  return jwt.sign(payload, JWT_ACCESS_SECRET, { expiresIn: JWT_ACCESS_TTL });
}

export function signRefreshToken(payload) {
  return jwt.sign(payload, JWT_REFRESH_SECRET, { expiresIn: JWT_REFRESH_TTL });
}

export function verifyAccess(token) {
  return jwt.verify(token, JWT_ACCESS_SECRET);
}

export function verifyRefresh(token) {
  return jwt.verify(token, JWT_REFRESH_SECRET);
}
