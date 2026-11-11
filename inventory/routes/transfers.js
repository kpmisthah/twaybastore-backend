// inventory/routes/transfers.js — two-step transfers and stocktakes.
import express from "express";
import { z } from "zod";
import { allow } from "../auth/auth.js";
import { STOCK_ADJUST, STOCK_READ, STOCK_WRITE } from "../auth/roles.js";
import { ah } from "../lib/http.js";
import { send } from "../lib/json.js";
import { idParam, parse, zId } from "../lib/validate.js";
import { STOCKTAKE_STATUSES, TRANSFER_STATUSES } from "../models/Transfer.js";
import {
  approveStocktake,
  cancelStocktake,
  createStocktake,
  getStocktake,
  listStocktakes,
  recordCount,
  reopenStocktake,
  submitStocktake,
} from "../services/stocktakes.js";
import { cancelTransfer, closeMissing, getTransfer, listTransfers, receiveTransfer, sendTransfer } from "../services/transfers.js";

export const transferRoutes = express.Router();
export const stocktakeRoutes = express.Router();

/** A variant, a kit box, or a whole kit (sent as all of its boxes). */
const TransferLine = z.object({ variantId: zId, quantity: z.number().int().min(1).max(100000) });
const SendTransfer = z.object({
  fromLocationId: zId,
  toLocationId: zId,
  lines: z.array(TransferLine).min(1).max(200),
  note: z.string().max(500).optional(),
});
const ReceiveTransfer = z.object({ lines: z.array(TransferLine).min(1).max(200) });
const Reason = z.object({ reason: z.string().trim().min(1, "Give a reason").max(300) });

transferRoutes.get(
  "/",
  allow(STOCK_READ),
  ah(async (req, res) => send(res, await listTransfers(parse(z.object({ status: z.enum(TRANSFER_STATUSES).optional() }), req.query))))
);
transferRoutes.get(
  "/:id",
  allow(STOCK_READ),
  ah(async (req, res) => send(res, await getTransfer(idParam(req.params.id))))
);
transferRoutes.post(
  "/",
  allow(STOCK_WRITE),
  ah(async (req, res) => send(res, await sendTransfer(req.staff, parse(SendTransfer, req.body)), 201))
);
transferRoutes.post(
  "/:id/receive",
  allow(STOCK_WRITE),
  ah(async (req, res) => send(res, await receiveTransfer(req.staff, idParam(req.params.id), parse(ReceiveTransfer, req.body))))
);
transferRoutes.post(
  "/:id/close",
  allow(STOCK_ADJUST),
  ah(async (req, res) => send(res, await closeMissing(req.staff, idParam(req.params.id), parse(Reason, req.body).reason)))
);
transferRoutes.post(
  "/:id/cancel",
  allow(STOCK_WRITE),
  ah(async (req, res) => send(res, await cancelTransfer(req.staff, idParam(req.params.id), parse(Reason, req.body).reason)))
);

// ------------------------------------------------------------------ stocktakes
// Anyone who handles stock can count; only admins/managers approve the corrections.

const CreateStocktake = z.object({ locationId: zId, note: z.string().max(300).optional() });
/** Either set the count (`counted`) or add to it (`add`, e.g. +1 per scan). */
const Count = z
  .object({
    variantId: zId,
    locationId: zId,
    counted: z.number().int().min(0).max(1000000).optional(),
    add: z.number().int().min(-1000).max(1000).optional(),
  })
  .refine((d) => (d.counted === undefined) !== (d.add === undefined), "Send either counted or add");

stocktakeRoutes.get(
  "/",
  allow(STOCK_READ),
  ah(async (req, res) => send(res, await listStocktakes(parse(z.object({ status: z.enum(STOCKTAKE_STATUSES).optional() }), req.query))))
);
stocktakeRoutes.get(
  "/:id",
  allow(STOCK_READ),
  ah(async (req, res) => send(res, await getStocktake(idParam(req.params.id))))
);
stocktakeRoutes.post(
  "/",
  allow(STOCK_WRITE),
  ah(async (req, res) => send(res, await createStocktake(req.staff, parse(CreateStocktake, req.body)), 201))
);
stocktakeRoutes.put(
  "/:id/counts",
  allow(STOCK_WRITE),
  ah(async (req, res) => send(res, await recordCount(req.staff, idParam(req.params.id), parse(Count, req.body))))
);
stocktakeRoutes.post(
  "/:id/submit",
  allow(STOCK_WRITE),
  ah(async (req, res) => {
    const { uncountedAsZero } = parse(z.object({ uncountedAsZero: z.boolean().optional() }), req.body);
    send(res, await submitStocktake(req.staff, idParam(req.params.id), uncountedAsZero ?? false));
  })
);
stocktakeRoutes.post(
  "/:id/approve",
  allow(STOCK_ADJUST),
  ah(async (req, res) => send(res, await approveStocktake(req.staff, idParam(req.params.id))))
);
stocktakeRoutes.post(
  "/:id/reopen",
  allow(STOCK_ADJUST),
  ah(async (req, res) => send(res, await reopenStocktake(req.staff, idParam(req.params.id))))
);
stocktakeRoutes.post(
  "/:id/cancel",
  allow(STOCK_ADJUST),
  ah(async (req, res) => send(res, await cancelStocktake(req.staff, idParam(req.params.id))))
);
