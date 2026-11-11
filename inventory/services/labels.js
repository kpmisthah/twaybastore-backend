// inventory/services/labels.js — barcode label PDFs, one label per page, sized for a label printer.
import bwipjs from "bwip-js";
import PDFDocument from "pdfkit";
import { badRequest } from "../lib/http.js";
import { Product, Variant } from "../models/Catalog.js";
import { shortPath, withDescendants } from "./locationTree.js";
import { withPaths } from "./locations.js";
import { getSettings } from "./settings.js";

const PT_PER_MM = 72 / 25.4;
export const MAX_LABELS_PER_JOB = 2000;

/** The SKU only adds information when someone set their own (generated SKUs equal the code). */
const extraSku = (sku, code) => (sku && sku !== code ? sku : null);

/**
 * requests: [{ variantId, copies }]. A kit expands to labels for each of its boxes
 * (copies × boxes per kit).
 */
export async function productLabels(requests) {
  const settings = await getSettings();
  const money = new Intl.NumberFormat("en-MT", { style: "currency", currency: settings.currency });

  const variants = await Variant.find({ _id: { $in: requests.map((r) => r.variantId) } }).lean();
  const byId = new Map(variants.map((v) => [String(v._id), v]));
  const productNames = new Map(
    (await Product.find({ _id: { $in: variants.map((v) => v.productId) } }).select("name").lean()).map((p) => [String(p._id), p.name])
  );
  const boxIds = variants.flatMap((v) => (v.components ?? []).map((c) => c.componentVariantId));
  const boxes = new Map((await Variant.find({ _id: { $in: boxIds } }).lean()).map((b) => [String(b._id), b]));

  const labels = [];
  for (const req of requests) {
    const v = byId.get(String(req.variantId));
    if (!v) throw badRequest("One of the selected items no longer exists");
    const title = productNames.get(String(v.productId));

    if (v.kind === "KIT") {
      for (const part of v.components ?? []) {
        const c = boxes.get(String(part.componentVariantId));
        if (!c?.active) continue;
        labels.push({
          content: { title, subtitle: c.name, code: c.code, price: null, sku: extraSku(c.sku, c.code) },
          copies: req.copies * part.quantity,
        });
      }
    } else {
      labels.push({
        content: {
          title,
          subtitle: v.name === "Default" ? null : v.name,
          code: v.code,
          sku: extraSku(v.sku, v.code),
          price: settings.labelShowPrice && v.kind === "STANDARD" && v.price != null ? money.format(Number(v.price)) : null,
        },
        copies: req.copies,
      });
    }
  }

  const total = labels.reduce((sum, l) => sum + l.copies, 0);
  if (total === 0) throw badRequest("Nothing to print");
  if (total > MAX_LABELS_PER_JOB) throw badRequest(`That is ${total} labels — print at most ${MAX_LABELS_PER_JOB} at a time`);

  return renderPdf(labels, settings.labelWidthMm, settings.labelHeightMm);
}

/**
 * One label per location: its name, the nearest part of its path and a barcode of its code.
 * With `withChildren`, a shelf also prints every space on it (hidden ones are skipped).
 */
export async function locationLabels(locationIds, withChildren) {
  const settings = await getSettings();
  const all = await withPaths();
  const known = new Set(all.map((l) => l.id));
  if (locationIds.some((id) => !known.has(id))) throw badRequest("One of the selected locations no longer exists");

  const selected = withChildren ? withDescendants(all, locationIds) : all.filter((l) => locationIds.includes(l.id));
  const active = selected.filter((l) => l.active);
  if (active.length === 0) throw badRequest("Nothing to print");
  if (active.length > MAX_LABELS_PER_JOB) {
    throw badRequest(`That is ${active.length} labels — print at most ${MAX_LABELS_PER_JOB} at a time`);
  }

  // Roughly what fits on one line of the smallest label text.
  const pathChars = Math.max(16, Math.floor(settings.labelWidthMm * 0.8));
  const labels = active.map((l) => ({
    content: { title: l.name, subtitle: shortPath(l.pathNames.slice(0, -1), pathChars) || null, code: l.code, price: null },
    copies: 1,
  }));
  return renderPdf(labels, settings.labelWidthMm, settings.labelHeightMm);
}

async function renderPdf(labels, widthMm, heightMm) {
  const width = widthMm * PT_PER_MM;
  const height = heightMm * PT_PER_MM;
  const pad = 1.5 * PT_PER_MM;
  const inner = width - pad * 2;

  const doc = new PDFDocument({ size: [width, height], margin: 0, autoFirstPage: false });
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  // Barcode images are identical for every copy, so render each once.
  const images = new Map();
  for (const { content } of labels) {
    if (!images.has(content.code)) {
      images.set(content.code, await bwipjs.toBuffer({ bcid: "code128", text: content.code, scale: 4, height: 12, includetext: false }));
    }
  }

  const titleSize = Math.min(8, height / 9);
  const smallSize = Math.min(7, height / 11);

  for (const { content, copies } of labels) {
    for (let i = 0; i < copies; i++) {
      doc.addPage({ size: [width, height], margin: 0 });
      let y = pad;

      doc.font("Helvetica-Bold").fontSize(titleSize);
      doc.text(content.title ?? "", pad, y, { width: inner, height: titleSize * 1.2, lineBreak: false, ellipsis: true });
      y += titleSize * 1.15;

      const sub = [content.subtitle, content.price].filter(Boolean).join("   ");
      if (sub) {
        doc.font("Helvetica").fontSize(smallSize);
        doc.text(sub, pad, y, { width: inner, height: smallSize * 1.2, lineBreak: false, ellipsis: true });
        y += smallSize * 1.15;
      }

      // Scanners need a blank "quiet zone" either side of the bars.
      const quiet = 3 * PT_PER_MM;
      const codeHeight = smallSize * 1.3;
      const barcodeHeight = height - y - pad - codeHeight;
      doc.image(images.get(content.code), quiet, y + 1, { fit: [width - quiet * 2, barcodeHeight - 1], align: "center" });

      doc.font("Helvetica").fontSize(smallSize);
      const codeLine = content.sku ? `${content.code}  ·  SKU ${content.sku}` : content.code;
      doc.text(codeLine, pad, height - pad - smallSize, { width: inner, align: "center", lineBreak: false, ellipsis: true });
    }
  }

  doc.end();
  return done;
}
