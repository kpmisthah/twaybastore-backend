// utils/generateCode.js
export default function generateCode(prefix = "WELCOME") {
  // 10-char base36 chunk (no ambiguous chars); uppercase
  const chunk = Math.random().toString(36).slice(2, 12).toUpperCase();
  return `${prefix}-${chunk}`;
}
