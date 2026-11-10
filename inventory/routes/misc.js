// inventory/routes/misc.js — label PDFs, photo uploads, dashboard figures and filter options.
import express from "express";
import multer from "multer";
import { z } from "zod";
import cloudinary from "../../utils/cloudinaryClient.js";
import { allow } from "../auth/auth.js";
import { AUDIT_READ, CATALOG_WRITE, DASHBOARD, LABEL_PRINT, REPORTS_READ, SALES_READ, STOCK_WRITE } from "../auth/roles.js";
import { dayRange, maltaToday } from "../lib/dates.js";
import { ah, badRequest } from "../lib/http.js";
import { send } from "../lib/json.js";
import { parse, zId } from "../lib/validate.js";
import { Category, Product } from "../models/Catalog.js";
import Location from "../models/Location.js";
import { ImportIssue, Order } from "../models/Order.js";
import { StockLevel, StockMovement } from "../models/Stock.js";
import User from "../models/User.js";
import { locationLabels, productLabels } from "../services/labels.js";
import { listLocations } from "../services/locations.js";
import { salesSummary } from "../services/sales.js";
import { lowStock } from "../services/stockQuery.js";

const router = express.Router();

// -------------------------------------------------------------------- labels

const ProductLabels = z.object({
  items: z.array(z.object({ variantId: zId, copies: z.number().int().min(1).max(500) })).min(1).max(200),
});
const LocationLabels = z.object({
  locationIds: z.array(zId).min(1).max(200),
  /** Also print everything inside the selected locations (e.g. all spaces on a shelf). */
  withChildren: z.boolean().optional(),
});

const sendPdf = (res, buffer, filename) => {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
  res.send(buffer);
};

router.post(
  "/labels/products",
  allow(LABEL_PRINT),
  ah(async (req, res) => sendPdf(res, await productLabels(parse(ProductLabels, req.body).items), "labels.pdf"))
);

router.post(
  "/labels/locations",
  allow(LABEL_PRINT),
  ah(async (req, res) => {
    const dto = parse(LocationLabels, req.body);
    sendPdf(res, await locationLabels(dto.locationIds, dto.withChildren ?? false), "location-labels.pdf");
  })
);

// ------------------------------------------------------------------- uploads

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } }).single("file");

/** Detect the image type from the file's first bytes, not its name or claimed type. */
function detectImageType(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}

/** Stored on Cloudinary (like the website's images), so photos survive server restarts and redeploys. */
const saveImage = (folder) =>
  ah(async (req, res) => {
    await new Promise((resolve, reject) => imageUpload(req, res, (err) => (err ? reject(badRequest(err.message)) : resolve())));
    if (!req.file) throw badRequest("Choose an image file");
    if (!detectImageType(req.file.buffer)) throw badRequest("Only JPG, PNG or WebP images are allowed");
    const url = await new Promise((resolve, reject) => {
      cloudinary.uploader
        .upload_stream({ folder: `twayba/inventory/${folder}`, resource_type: "image" }, (err, result) =>
          err ? reject(err) : resolve(result.secure_url)
        )
        .end(req.file.buffer);
    });
    res.status(201).json({ url });
  });

/** One product image (JPG, PNG or WebP, max 5 MB). */
router.post("/uploads/products", allow(CATALOG_WRITE), saveImage("products"));
/** Photo of a delivery, a damaged box or a failed drop-off, taken by the driver. */
router.post("/uploads/deliveries", allow(STOCK_WRITE), saveImage("deliveries"));

// ----------------------------------------------------------------- dashboard

/** The numbers on the dashboard (spec §11). Sales figures only for roles that may see sales. */
router.get(
  "/dashboard",
  allow(DASHBOARD),
  ah(async (req, res) => {
    const realLocations = await Location.find({ type: { $nin: ["TRANSIT", "DAMAGED"] } }).distinct("_id");
    const [products, stock, low, recent, needsSetup] = await Promise.all([
      Product.countDocuments({ status: "ACTIVE" }),
      StockLevel.aggregate([{ $match: { locationId: { $in: realLocations } } }, { $group: { _id: null, n: { $sum: "$onHand" } } }]),
      lowStock(),
      StockMovement.find()
        .sort({ createdAt: -1 })
        .limit(6)
        .populate("userId", "name")
        .populate({ path: "variantId", select: "code name productId", populate: { path: "productId", select: "name" } })
        .lean(),
      Product.countDocuments({ needsSetup: true, status: "ACTIVE" }),
    ]);
    const today = dayRange(maltaToday(), maltaToday());
    const canSeeSales = SALES_READ.includes(req.staff.role);
    const [orderCounts, ordersToday, websiteIssues, money] = await Promise.all([
      Order.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
      Order.countDocuments({ createdAt: today }),
      ImportIssue.countDocuments({ status: "OPEN" }),
      canSeeSales ? salesSummary(today.$gte, today.$lt) : null,
    ]);
    const count = (...statuses) => orderCounts.filter((o) => statuses.includes(o._id)).reduce((sum, o) => sum + o.n, 0);
    send(res, {
      products,
      stockUnits: stock[0]?.n ?? 0,
      lowStock: low.length,
      lowStockTop: low.slice(0, 3),
      /** Website products that still need labels and stock. */
      needsSetup,
      orders: {
        today: ordersToday,
        pending: count("NEW", "ALLOCATED", "PICKING"),
        readyForDelivery: count("LOADED"),
        outForDelivery: count("OUT_FOR_DELIVERY"),
        failed: count("FAILED"),
      },
      /** Website orders that could not be imported and need someone to look. */
      websiteIssues,
      sales: money && { count: money.salesCount, total: money.salesTotal },
      returns: money && { count: money.returnsCount, total: money.returnsTotal },
      recentMovements: recent.map(({ userId: u, variantId: v, ...m }) => ({
        ...m,
        user: u ? { name: u.name } : null,
        variant: v ? { code: v.code, name: v.name, product: { id: v.productId?._id, name: v.productId?.name } } : null,
      })),
    });
  })
);

/** Choices for report and audit filters. */
router.get(
  "/reports/options",
  allow([...new Set([...REPORTS_READ, ...AUDIT_READ])]),
  ah(async (req, res) => {
    const [users, categories, all] = await Promise.all([
      User.find().select("name role active").sort({ name: 1 }).lean(),
      Category.find().select("name").sort({ nameKey: 1 }).lean(),
      listLocations(false),
    ]);
    send(res, {
      users,
      categories,
      locations: all.filter((l) => l.type !== "TRANSIT" && l.type !== "DAMAGED").map((l) => ({ id: l.id, path: l.path })),
    });
  })
);

export default router;
