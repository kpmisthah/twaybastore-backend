// inventory/routes/imports.js — Excel/CSV import. Upload once without ?commit=true to check, then again with it to save.
import express from "express";
import multer from "multer";
import { allow } from "../auth/auth.js";
import { CATALOG_WRITE, STOCK_ADJUST } from "../auth/roles.js";
import { ah, badRequest } from "../lib/http.js";
import { importOpeningStock, importProducts, productTemplate, stockTemplate } from "../services/imports.js";

const router = express.Router();
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } }).single("file");

/** Runs multer, turning its errors (file too big…) into a 400. */
const withFile = (req, res, next) =>
  upload(req, res, (err) => {
    if (err) return next(badRequest(err.code === "LIMIT_FILE_SIZE" ? "The file is too big (max 5 MB)" : err.message));
    if (!req.file) return next(badRequest("Choose an Excel or CSV file"));
    next();
  });

const download = (res, buffer, filename) => {
  res.setHeader("Content-Type", XLSX);
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(buffer);
};

router.get(
  "/products/template",
  allow(CATALOG_WRITE),
  ah(async (req, res) => download(res, await productTemplate(), "products-template.xlsx"))
);
router.get(
  "/stock/template",
  allow(STOCK_ADJUST),
  ah(async (req, res) => download(res, await stockTemplate(), "opening-stock-template.xlsx"))
);
router.post(
  "/products",
  allow(CATALOG_WRITE),
  withFile,
  ah(async (req, res) => res.json(await importProducts(req.staff, req.file.buffer, req.query.commit === "true")))
);
router.post(
  "/stock",
  allow(STOCK_ADJUST),
  withFile,
  ah(async (req, res) => res.json(await importOpeningStock(req.staff, req.file.buffer, req.query.commit === "true")))
);

export default router;
