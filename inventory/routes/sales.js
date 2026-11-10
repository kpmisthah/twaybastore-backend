// inventory/routes/sales.js — POS sales, invoices/receipts and returns (credit notes).
import express from "express";
import { z } from "zod";
import { allow } from "../auth/auth.js";
import { POS, SALES_READ } from "../auth/roles.js";
import { ah, badRequest } from "../lib/http.js";
import { send } from "../lib/json.js";
import { idParam, parse, zDate, zId, zQueryInt } from "../lib/validate.js";
import { PAYMENT_METHODS, RETURN_CONDITIONS } from "../models/Sale.js";
import { creditNotePdf, invoicePdf, receiptPdf } from "../services/documents.js";
import { createReturn, getReturn, listReturns } from "../services/returns.js";
import { createSale, findSaleByNumber, getSale, listSales, previewSale, salesSummary } from "../services/sales.js";

export const saleRoutes = express.Router();
export const returnRoutes = express.Router();

const zMoney2 = (min, max) =>
  z
    .number()
    .min(min)
    .max(max)
    .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, "At most 2 decimal places");

const PriceLine = z.object({
  /** A STANDARD variant, or a KIT variant for a whole kit. */
  variantId: zId,
  quantity: z.number().int().min(1).max(10000),
  discountPercent: zMoney2(0, 100).optional(),
});
const SalePick = z.object({ variantId: zId, locationId: zId, quantity: z.number().int().min(1).max(10000) });
const SaleLine = PriceLine.extend({
  /** Where the stock came from: one entry per space (a kit has entries for every box). */
  picks: z.array(SalePick).min(1).max(100),
});
const Payment = z.object({
  method: z.enum(PAYMENT_METHODS),
  amount: zMoney2(0.01, 10_000_000),
  reference: z.string().max(100).optional(),
});
/** An admin/manager types their login on the cashier's device to approve a big discount. */
const Approval = z.object({ login: z.string().trim().min(1).max(200), password: z.string().min(1).max(200) });

const PreviewSale = z.object({ lines: z.array(PriceLine).max(200) });
const CreateSale = z.object({
  siteId: zId.optional(),
  customerName: z.string().max(100).optional(),
  customerPhone: z.string().max(30).optional(),
  note: z.string().max(500).optional(),
  lines: z.array(SaleLine).min(1).max(200),
  payments: z.array(Payment).min(1).max(10),
  approval: Approval.optional(),
});
const ListQuery = z.object({
  q: z.string().max(100).optional(),
  from: zDate.optional(),
  to: zDate.optional(),
  page: zQueryInt(1, 100000).optional(),
  pageSize: zQueryInt(1, 100).optional(),
});

const pdf = (res, buffer, filename) => {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
  res.send(buffer);
};

/** Cart totals, priced exactly as the sale will be. */
saleRoutes.post(
  "/preview",
  allow(POS),
  ah(async (req, res) => send(res, await previewSale(req.staff, parse(PreviewSale, req.body).lines)))
);
saleRoutes.post(
  "/",
  allow(POS),
  ah(async (req, res) => send(res, await createSale(req.staff, parse(CreateSale, req.body)), 201))
);
saleRoutes.get(
  "/",
  allow(SALES_READ),
  ah(async (req, res) => send(res, await listSales(parse(ListQuery, req.query))))
);
/** GET /sales/summary?from=…&to=… (ISO date-times) */
saleRoutes.get(
  "/summary",
  allow(SALES_READ),
  ah(async (req, res) => {
    const from = new Date(String(req.query.from));
    const to = new Date(String(req.query.to));
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw badRequest("from and to must be dates");
    send(res, await salesSummary(from, to));
  })
);
/** GET /sales/by-number/INV-000012 */
saleRoutes.get(
  "/by-number/:invoice",
  allow(SALES_READ),
  ah(async (req, res) => send(res, await findSaleByNumber(String(req.params.invoice).slice(0, 40))))
);
saleRoutes.get(
  "/:id",
  allow(SALES_READ),
  ah(async (req, res) => send(res, await getSale(idParam(req.params.id))))
);
saleRoutes.get(
  "/:id/invoice",
  allow(SALES_READ),
  ah(async (req, res) => {
    const { sale, pdf: buffer } = await invoicePdf(idParam(req.params.id));
    pdf(res, buffer, `${sale.invoiceNumber}.pdf`);
  })
);
saleRoutes.get(
  "/:id/receipt",
  allow(SALES_READ),
  ah(async (req, res) => {
    const { sale, pdf: buffer } = await receiptPdf(idParam(req.params.id));
    pdf(res, buffer, `receipt-${sale.invoiceNumber}.pdf`);
  })
);

// ------------------------------------------------------------------ returns

const ReturnLine = z.object({
  saleLineId: zId,
  quantity: z.number().int().min(1).max(10000),
  condition: z.enum(RETURN_CONDITIONS),
  /** Where good items go back to. Ignored for DAMAGED (always the Damaged location). */
  locationId: zId.optional(),
});
const CreateReturn = z.object({
  saleId: zId,
  lines: z.array(ReturnLine).min(1).max(200),
  refundMethod: z.enum(PAYMENT_METHODS),
  refundReference: z.string().max(100).optional(),
  reason: z.string().max(300).optional(),
});
const ReturnsQuery = z.object({
  q: z.string().max(100).optional(),
  page: zQueryInt(1, 100000).optional(),
  pageSize: zQueryInt(1, 100).optional(),
});

returnRoutes.post(
  "/",
  allow(POS),
  ah(async (req, res) => send(res, await createReturn(req.staff, parse(CreateReturn, req.body)), 201))
);
returnRoutes.get(
  "/",
  allow(SALES_READ),
  ah(async (req, res) => send(res, await listReturns(parse(ReturnsQuery, req.query))))
);
returnRoutes.get(
  "/:id",
  allow(SALES_READ),
  ah(async (req, res) => send(res, await getReturn(idParam(req.params.id))))
);
returnRoutes.get(
  "/:id/pdf",
  allow(SALES_READ),
  ah(async (req, res) => {
    const { note, pdf: buffer } = await creditNotePdf(idParam(req.params.id));
    pdf(res, buffer, `${note.creditNumber}.pdf`);
  })
);
