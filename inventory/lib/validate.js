// inventory/lib/validate.js
// Shared zod field rules (the NestJS DTO decorators, ported).
import mongoose from "mongoose";
import { z } from "zod";
import { badRequest, zodMessage } from "./http.js";

/** Parses `data` with `schema`, or throws a 400 with a readable message. */
export function parse(schema, data) {
  const result = schema.safeParse(data ?? {});
  if (!result.success) throw badRequest(zodMessage(result.error));
  return result.data;
}

export const zId = z.string().refine((v) => mongoose.isValidObjectId(v) && /^[a-f0-9]{24}$/i.test(v), "Invalid id");

/** Route param check — throws 400 instead of letting a CastError through. */
export function idParam(value, label = "id") {
  if (!/^[a-f0-9]{24}$/i.test(String(value))) throw badRequest(`Invalid ${label}`);
  return String(value);
}

/** Letters, digits and - _ . / — what label printers and scanners handle reliably. */
export const SKU_PATTERN = /^[A-Za-z0-9][A-Za-z0-9\-_./]{0,63}$/;
/** Printable ASCII without spaces, 3–64 chars (EAN, UPC, Code 128 contents). */
export const BARCODE_PATTERN = /^[\x21-\x7E]{3,64}$/;
export const PHONE_PATTERN = /^\+?[\d\s-]{6,20}$/;
export const PASSWORD_MIN_LENGTH = 8;

export const zSku = z
  .string()
  .trim()
  .regex(SKU_PATTERN, "SKU may only contain letters, numbers and - _ . / (max 64)");
export const zBarcode = z.string().trim().regex(BARCODE_PATTERN, "Barcode must be 3–64 characters with no spaces");
export const zMoney = z
  .number()
  .min(0)
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, "At most 2 decimal places");
export const zShort = (max = 60) => z.string().max(max);
export const zInt = (min, max) => z.number().int().min(min).max(max);
/** Query-string integer ("2" → 2). */
export const zQueryInt = (min, max) => z.coerce.number().int().min(min).max(max);
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
export const zBoolString = z.enum(["true", "false"]).transform((v) => v === "true");

/** Escapes text for use inside a RegExp (search boxes). */
export const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Rounds money to cents. */
export const money = (v) => (v === null || v === undefined ? v : Math.round(Number(v) * 100) / 100);
