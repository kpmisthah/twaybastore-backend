// inventory/lib/password.js
import bcrypt from "bcryptjs";

export function hashPassword(plain) {
  return bcrypt.hash(plain, 12);
}

export function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

/** Keep digits and a leading +, so "+356 7912 3456" and "+35679123456" match. */
export function normalizePhone(value) {
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, "");
  return trimmed.startsWith("+") ? `+${digits}` : digits;
}
