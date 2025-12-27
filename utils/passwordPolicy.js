// utils/passwordPolicy.js
import zxcvbn from "zxcvbn"; // optional: npm i zxcvbn

export function validateStrongPassword(pw) {
  if (typeof pw !== "string" || pw.length < 12) {
    return { ok: false, message: "Password must be at least 12 characters." };
  }
  const score = zxcvbn(pw).score; // 0..4
  if (score < 3) {
    return { ok: false, message: "Password is too weak. Use a longer, unique passphrase." };
  }
  return { ok: true };
}
