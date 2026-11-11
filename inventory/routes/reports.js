// inventory/routes/reports.js — report catalogue, report data and Excel export.
// (GET /reports/options, the filter choices, lives in misc.js.)
import express from "express";
import { z } from "zod";
import { allow } from "../auth/auth.js";
import { REPORTS_READ } from "../auth/roles.js";
import { ah, notFound } from "../lib/http.js";
import { send } from "../lib/json.js";
import { parse, zDate, zId } from "../lib/validate.js";
import { describeFilters, REPORTS, reportToXlsx, runReport } from "../services/reports.js";
import { getSettings } from "../services/settings.js";

const router = express.Router();

const ReportQuery = z.object({
  from: zDate.optional(),
  to: zDate.optional(),
  productId: zId.optional(),
  locationId: zId.optional(),
  userId: zId.optional(),
  categoryId: zId.optional(),
});

/** Empty query values ("?from=") mean "no filter". */
const query = (req) => parse(ReportQuery, Object.fromEntries(Object.entries(req.query).filter(([, v]) => v !== "")));

router.get("/", allow(REPORTS_READ), (req, res) => res.json(REPORTS));

router.get(
  "/:type",
  allow(REPORTS_READ),
  ah(async (req, res) => send(res, await runReport(req.params.type, query(req), req.staff)))
);

router.get(
  "/:type/xlsx",
  allow(REPORTS_READ),
  ah(async (req, res) => {
    const type = req.params.type;
    if (!REPORTS.some((r) => r.type === type)) throw notFound("Unknown report");
    const q = query(req);
    const [report, settings, subtitle] = await Promise.all([runReport(type, q, req.staff), getSettings(), describeFilters(q)]);
    const file = await reportToXlsx(report, subtitle, settings.businessName);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${type}-${stamp}.xlsx"`);
    res.send(file);
  })
);

export default router;
