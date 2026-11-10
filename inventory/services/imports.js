// inventory/services/imports.js — bulk import from Excel/CSV. Every call first checks every row;
// with `commit` it then saves (nothing is saved while any row has a problem).
//  - Products: rows with the same product name become one product with several colours/sizes.
//    (Website products arrive by themselves; this is for items sold only in the shop.)
//  - Opening stock: one STOCK_IN per row, all in one transaction (all rows or none).
import { Readable } from "node:stream";
import ExcelJS from "exceljs";
import { RESERVED_CODE, variantName } from "../lib/codes.js";
import { badRequest } from "../lib/http.js";
import { escapeRegex } from "../lib/validate.js";
import { Barcode, Category, Product, TaxRate, Variant } from "../models/Catalog.js";
import { audit } from "./audit.js";
import { withPaths } from "./locations.js";
import { SYSTEM_TYPES } from "./locationTree.js";
import { createProduct } from "./products.js";
import { applyMoves } from "./stock.js";

export const MAX_IMPORT_ROWS = 5000;
const s = (v) => (v == null ? v : String(v));
const key = (v) => v.trim().toLowerCase();

export const PRODUCT_COLUMNS = {
  name: ["Product name"],
  color: ["Colour", "Color"],
  size: ["Size"],
  sku: ["SKU"],
  barcode: ["Supplier barcode", "Barcode"],
  category: ["Category"],
  brand: ["Brand"],
  price: ["Price", "Selling price"],
  cost: ["Cost price", "Cost"],
  vat: ["VAT rate", "VAT"],
  minStock: ["Minimum stock", "Min stock"],
  description: ["Description"],
};

export const STOCK_COLUMNS = {
  item: ["SKU or barcode", "SKU", "Barcode", "Code"],
  location: ["Location", "Location code", "Location code or path"],
  quantity: ["Quantity", "Qty"],
  note: ["Note"],
};

// ---------------------------------------------------------------- sheets

/** Header text → our key, ignoring case, spaces, '*' and punctuation ("Product name *" → "productname"). */
const norm = (v) => v.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Excel cells can be numbers, dates, rich text or formulas — turn them into plain text. */
function cellText(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    if (v.richText) return v.richText.map((t) => t.text).join("");
    if (v.result !== undefined) return cellText(v.result);
    if (v.text !== undefined) return String(v.text);
  }
  return String(v);
}

/**
 * Reads the first sheet of an .xlsx file, or a .csv file, into [{ row, values }] keyed by column.
 * `columns` maps our keys to the header texts we accept for them.
 */
export async function readSheet(file, columns) {
  const wb = new ExcelJS.Workbook();
  const isXlsx = file.subarray(0, 2).toString("latin1") === "PK"; // .xlsx is a zip file
  try {
    if (isXlsx) await wb.xlsx.load(file);
    // Keep every CSV value as text: "00123" or a 16-digit barcode must not become a number.
    else await wb.csv.read(Readable.from(file.toString("utf8").replace(/^﻿/, "")), { map: (value) => value });
  } catch {
    throw badRequest("Could not read the file — save it as Excel (.xlsx) or CSV");
  }
  const ws = wb.worksheets[0];
  if (!ws || ws.rowCount < 2) throw badRequest("The file has no rows under the header");

  // Find the header row (the template has an instructions line above it).
  const wanted = new Map();
  for (const [k, labels] of Object.entries(columns)) for (const l of labels) wanted.set(norm(l), k);
  let headerRow = 0;
  let colKeys = [];
  for (let r = 1; r <= Math.min(ws.rowCount, 10); r++) {
    const cells = ws.getRow(r).values.slice(1).map((v) => wanted.get(norm(cellText(v))));
    if (cells.filter(Boolean).length >= 2) {
      headerRow = r;
      colKeys = cells;
      break;
    }
  }
  if (!headerRow) {
    throw badRequest(`Header row not found. Use the template — expected columns like: ${Object.values(columns).map((l) => l[0]).join(", ")}`);
  }

  const rows = [];
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const raw = ws.getRow(r).values.slice(1);
    const values = Object.fromEntries(colKeys.filter(Boolean).map((k) => [k, ""]));
    raw.forEach((v, i) => {
      const k = colKeys[i];
      if (k) values[k] = cellText(v).trim();
    });
    if (Object.values(values).every((v) => !v)) continue; // blank line
    rows.push({ row: r, values });
    if (rows.length > MAX_IMPORT_ROWS) throw badRequest(`Import at most ${MAX_IMPORT_ROWS} rows at a time`);
  }
  if (!rows.length) throw badRequest("The file has no rows under the header");
  return rows;
}

/** "12,50", "€12.50", "12.5" → 12.5; empty → null; invalid → NaN. */
export function parseNumber(v) {
  if (!v) return null;
  const cleaned = v.replace(/[€\s]/g, "").replace(/,(\d{1,2})$/, ".$1").replace(/,/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * A downloadable template: an instructions line, a bold header and example rows.
 * `textColumns` (0-based) are formatted as Text so Excel keeps leading zeros in codes.
 */
export async function templateXlsx(sheetName, instructions, headers, examples, textColumns = []) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  ws.addRow([instructions]).font = { italic: true, color: { argb: "FF666666" } };
  const header = ws.addRow(headers);
  header.font = { bold: true };
  header.eachCell((c) => (c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F5F9" } }));
  for (const e of examples) ws.addRow(e);
  headers.forEach((h, i) => (ws.getColumn(i + 1).width = Math.max(14, h.length + 4)));
  for (const i of textColumns) ws.getColumn(i + 1).numFmt = "@";
  ws.views = [{ state: "frozen", ySplit: 2 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export const productTemplate = () =>
  templateXlsx(
    "Products",
    "One row per item. Rows with the same Product name become one product with several colours/sizes. Leave SKU empty to have one generated. Multi-box kits are added in the app. (Products on the website appear here by themselves — only import items sold in the shop.)",
    ["Product name *", "Colour", "Size", "SKU", "Supplier barcode", "Category", "Brand", "Price *", "Cost price", "VAT rate", "Minimum stock", "Description"],
    [
      ["Dining chair", "Black", "", "CHAIR-BLK", "5012345678900", "Chairs", "Nordic", 49.5, 20, "Standard VAT", 5, "Solid beech"],
      ["Dining chair", "White", "", "CHAIR-WHT", "", "Chairs", "Nordic", 49.5, 20, "Standard VAT", 5, ""],
      ["Desk lamp", "", "", "", "", "Lighting", "", 19.99, "", "18", "", ""],
    ],
    [3, 4]
  );

export const stockTemplate = () =>
  templateXlsx(
    "Opening stock",
    "One row per item per place. Location = the code on its label (LOC-000012) or the full path. For multi-box kits, enter each box separately.",
    ["SKU or barcode *", "Location *", "Quantity *", "Note"],
    [
      ["CHAIR-BLK", "LOC-000012", 6, ""],
      ["5012345678900", "Hamrun Shop › Top › Room 1 › Shelf A › A1", 2, "Counted 1 Oct"],
    ],
    [0, 1]
  );

const tally = (rows) => ({ okCount: rows.filter((r) => r.ok).length, errorCount: rows.filter((r) => !r.ok).length });

// ---------------------------------------------------------------- products

export async function importProducts(user, file, commit) {
  const rows = await readSheet(file, PRODUCT_COLUMNS);
  const [categories, rates, existingProducts] = await Promise.all([
    Category.find().select("name").lean(),
    TaxRate.find({ active: true }).select("name rate").lean(),
    Product.find().select("name").lean(),
  ]);
  const categoryByName = new Map(categories.map((c) => [key(c.name), s(c._id)]));
  const existingNames = new Set(existingProducts.map((p) => key(p.name)));

  // Codes already used anywhere (SKUs and barcodes are unique system-wide).
  const skus = rows.map((r) => r.values.sku).filter(Boolean);
  const barcodes = rows.map((r) => r.values.barcode).filter(Boolean);
  const [takenSkus, takenBarcodes] = await Promise.all([
    skus.length ? Variant.find({ sku: { $in: skus.map((x) => new RegExp(`^${escapeRegex(x)}$`, "i")) } }).select("sku").lean() : [],
    Barcode.find({ code: { $in: barcodes } }).select("code").lean(),
  ]);
  const skuTaken = new Set(takenSkus.map((x) => key(x.sku)));
  const barcodeTaken = new Set(takenBarcodes.map((b) => b.code));
  const seenSku = new Map();
  const seenBarcode = new Map();

  // Group rows into products.
  const groups = new Map();
  for (const r of rows) {
    const name = r.values.name?.trim();
    const k = name ? key(name) : `__missing_${r.row}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }

  const results = new Map();
  const plans = [];

  for (const [k, group] of groups) {
    const first = group[0].values;
    const groupErrors = [];
    if (k.startsWith("__missing_")) groupErrors.push("Product name is required");
    else if (existingNames.has(k)) groupErrors.push(`A product called "${first.name}" already exists`);

    let taxRateId;
    if (first.vat) {
      const pct = parseNumber(first.vat.replace("%", ""));
      const rate =
        rates.find((t) => key(t.name) === key(first.vat)) ?? (pct !== null && !Number.isNaN(pct) ? rates.find((t) => Number(t.rate) === pct) : undefined);
      if (!rate) groupErrors.push(`VAT rate "${first.vat}" not found (add it under Settings first)`);
      else taxRateId = s(rate._id);
    }
    const minStock = parseNumber(first.minStock);
    if (minStock !== null && (Number.isNaN(minStock) || minStock < 0 || !Number.isInteger(minStock))) groupErrors.push("Minimum stock must be a whole number");

    const variantNames = new Set();
    const variants = group.map((r) => {
      const v = r.values;
      const errors = [];
      const price = parseNumber(v.price);
      const cost = parseNumber(v.cost);
      if (price === null) errors.push("Price is required");
      else if (Number.isNaN(price) || price < 0) errors.push(`Price "${v.price}" is not a valid amount`);
      if (cost !== null && (Number.isNaN(cost) || cost < 0)) errors.push(`Cost price "${v.cost}" is not a valid amount`);
      for (const [label, code, taken, seen] of [
        ["SKU", v.sku, skuTaken, seenSku],
        ["Barcode", v.barcode, barcodeTaken, seenBarcode],
      ]) {
        if (!code) continue;
        const c = label === "SKU" ? key(code) : code;
        if (RESERVED_CODE.test(code)) errors.push(`${label} "${code}" looks like a system code — leave it empty and one is generated`);
        if (taken.has(c)) errors.push(`${label} "${code}" is already used by another item`);
        if (seen.has(c)) errors.push(`${label} "${code}" also appears on row ${seen.get(c)}`);
        seen.set(c, r.row);
      }
      const vName = variantName(v.color, v.size).toLowerCase();
      if (variantNames.has(vName)) errors.push(`Two rows have the same colour/size for "${first.name}"`);
      variantNames.add(vName);
      results.set(r.row, { row: r.row, ok: false, summary: "", errors });
      return {
        sku: v.sku || undefined,
        color: v.color || undefined,
        size: v.size || undefined,
        price: price ?? 0,
        costPrice: cost ?? undefined,
        barcode: v.barcode || undefined,
      };
    });

    const newCategory = first.category && !categoryByName.has(key(first.category)) ? first.category.trim() : undefined;
    const groupOk = !groupErrors.length && group.every((r) => !results.get(r.row).errors.length);
    group.forEach((r, i) => {
      const res = results.get(r.row);
      res.errors.unshift(...(i === 0 ? groupErrors : groupErrors.length ? ["See the first row of this product"] : []));
      res.ok = groupOk;
      res.summary =
        i === 0
          ? `New product "${first.name}"${group.length > 1 ? ` with ${group.length} variants` : ""}${newCategory ? ` · new category "${newCategory}"` : ""}`
          : `Variant of "${first.name}" (${variantName(r.values.color, r.values.size)})`;
    });
    if (groupOk) {
      plans.push({
        rows: group,
        newCategory,
        dto: {
          name: first.name.trim(),
          type: "STANDARD",
          brand: first.brand || undefined,
          description: first.description || undefined,
          minStock: minStock ?? undefined,
          taxRateId,
          categoryId: first.category ? categoryByName.get(key(first.category)) : undefined,
          variants,
        },
      });
    }
  }

  const ordered = rows.map((r) => results.get(r.row));
  const result = { rows: ordered, ...tally(ordered), committed: false };
  if (!commit || result.errorCount) return result;

  let created = 0;
  for (const plan of plans) {
    try {
      if (plan.newCategory) {
        const c = await Category.findOneAndUpdate(
          { nameKey: key(plan.newCategory) },
          { $setOnInsert: { name: plan.newCategory, nameKey: key(plan.newCategory), active: true } },
          { upsert: true, new: true }
        ).lean();
        plan.dto.categoryId = s(c._id);
      }
      await createProduct(user.id, plan.dto);
      created++;
    } catch (e) {
      // Should be rare (checked above) — e.g. someone created the same SKU meanwhile.
      for (const r of plan.rows) {
        const res = results.get(r.row);
        res.ok = false;
        res.errors.push(`Not imported: ${e.message}`);
      }
    }
  }
  await audit({ userId: user.id, action: "PRODUCTS_IMPORTED", entity: "Product", data: { products: created, rows: rows.length } });
  return { rows: ordered, ...tally(ordered), committed: true, created };
}

// ---------------------------------------------------------------- opening stock

export async function importOpeningStock(user, file, commit) {
  const rows = await readSheet(file, STOCK_COLUMNS);
  const all = await withPaths();
  const parents = new Set(all.filter((l) => l.active && l.parentId).map((l) => l.parentId));
  const byCode = new Map(all.map((l) => [l.code.toUpperCase(), l]));
  const pathKey = (p) => key(p.replace(/\s*[›>]\s*/g, ">"));
  const byPath = new Map(all.map((l) => [pathKey(l.path), l]));

  const codes = rows.map((r) => r.values.item).filter(Boolean);
  const [variants, barcodes] = await Promise.all([
    codes.length
      ? Variant.find({
          $or: [{ sku: { $in: codes.map((c) => new RegExp(`^${escapeRegex(c)}$`, "i")) } }, { code: { $in: codes.map((c) => c.toUpperCase()) } }],
        })
          .select("sku code kind name productId")
          .populate("productId", "name")
          .lean()
      : [],
    Barcode.find({ code: { $in: codes }, active: true }).select("code variantId").lean(),
  ]);
  const barcodeVariants = await Variant.find({ _id: { $in: barcodes.map((b) => b.variantId) } })
    .select("sku code kind name productId")
    .populate("productId", "name")
    .lean();
  const findVariant = (c) => {
    const direct = variants.find((v) => (v.sku && key(v.sku) === key(c)) || v.code === c.toUpperCase());
    if (direct) return direct;
    const b = barcodes.find((x) => x.code === c);
    return b ? barcodeVariants.find((v) => s(v._id) === s(b.variantId)) : undefined;
  };

  const reference = `IMPORT-${new Date().toISOString().slice(0, 10)}`;
  const moves = [];
  const results = rows.map((r) => {
    const v = r.values;
    const errors = [];
    const variant = v.item ? findVariant(v.item) : undefined;
    if (!v.item) errors.push("SKU or barcode is required");
    else if (!variant) errors.push(`No item with SKU/barcode "${v.item}"`);
    else if (variant.kind === "KIT") errors.push(`"${v.item}" is a whole kit — enter stock for each box`);

    const loc = v.location ? (byCode.get(v.location.toUpperCase()) ?? byPath.get(pathKey(v.location))) : undefined;
    if (!v.location) errors.push("Location is required");
    else if (!loc) errors.push(`Location "${v.location}" not found (use its label code, e.g. LOC-000012, or its full path)`);
    else if (!loc.active || SYSTEM_TYPES.includes(loc.type)) errors.push(`${loc.path} can't hold stock`);
    else if (parents.has(loc.id)) errors.push(`${loc.path} has spaces inside — use the exact space`);

    const qty = parseNumber(v.quantity);
    if (qty === null) errors.push("Quantity is required");
    else if (Number.isNaN(qty) || qty <= 0 || !Number.isInteger(qty)) errors.push(`Quantity "${v.quantity}" must be a whole number above 0`);

    const ok = !errors.length;
    if (ok) {
      moves.push({ type: "STOCK_IN", variantId: s(variant._id), quantity: qty, toLocationId: loc.id, reason: "Opening stock", note: v.note || "Imported", reference });
    }
    const name = variant ? `${variant.productId?.name}${variant.name !== "Default" ? ` – ${variant.name}` : ""}` : v.item;
    return { row: r.row, ok, summary: ok ? `${qty} × ${name} → ${loc.path}` : "", errors };
  });

  const result = { rows: results, ...tally(results), committed: false };
  if (!commit || result.errorCount) return result;

  await applyMoves(user.id, moves);
  await audit({ userId: user.id, action: "STOCK_IMPORTED", entity: "StockMovement", data: { rows: moves.length, units: moves.reduce((t, m) => t + m.quantity, 0) } });
  return { ...result, committed: true, created: moves.length };
}
