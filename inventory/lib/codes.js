// inventory/lib/codes.js
// Internal code helpers. Codes are generated once and never change.

export const CODE_PREFIX = "TW";
export const LOCATION_PREFIX = "LOC";

/** "TW-123…" and "LOC-123…" are reserved for generated codes, so manual entries never collide with them. */
export const RESERVED_CODE = new RegExp(`^(${CODE_PREFIX}|${LOCATION_PREFIX})-\\d`, "i");

/** 123 → "TW-000123" */
export function productCode(number) {
  return `${CODE_PREFIX}-${String(number).padStart(6, "0")}`;
}

/** 12 → "LOC-000012" */
export function locationCode(number) {
  return `${LOCATION_PREFIX}-${String(number).padStart(6, "0")}`;
}

/** Variant n (1-based) of a product: "TW-000123-01". */
export function variantCode(base, n) {
  return `${base}-${String(n).padStart(2, "0")}`;
}

/** 0 → A, 25 → Z, 26 → AA, 27 → AB … (spreadsheet-style). */
export function boxLetter(index) {
  let n = index;
  let letters = "";
  do {
    letters = String.fromCharCode(65 + (n % 26)) + letters;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return letters;
}

/** Box n (0-based) of a kit: "TW-000200-A". */
export function componentCode(base, index) {
  return `${base}-${boxLetter(index)}`;
}

/** "Black", "Large" → "Black / Large"; nothing → "Default". */
export function variantName(color, size) {
  const parts = [color?.trim(), size?.trim()].filter(Boolean);
  return parts.length ? parts.join(" / ") : "Default";
}

/** "Box A", "Side panels" → "Box A – Side panels". */
export function componentName(index, label) {
  const box = `Box ${boxLetter(index)}`;
  return label?.trim() ? `${box} – ${label.trim()}` : box;
}
