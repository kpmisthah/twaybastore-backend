// inventory/routes/stock.js
import express from "express";
import { z } from "zod";
import { allow } from "../auth/auth.js";
import { STOCK_ADJUST, STOCK_READ, STOCK_WRITE } from "../auth/roles.js";
import { ah, forbidden } from "../lib/http.js";
import { send } from "../lib/json.js";
import { idParam, parse, zId, zQueryInt } from "../lib/validate.js";
import { MOVEMENT_TYPES } from "../models/Stock.js";
import { assertSiteAccess } from "../services/locations.js";
import { ADD_REASONS, REMOVE_REASONS } from "../services/movementRules.js";
import { recordManual } from "../services/stock.js";
import { locationStock, lowStock, movements, productStock } from "../services/stockQuery.js";

const router = express.Router();

/** What people can do by hand. Reserve/load/deliver/sale come from orders and the POS. */
const MANUAL_TYPES = ["STOCK_IN", "STOCK_OUT", "TRANSFER", "DAMAGE", "ADJUSTMENT"];

const ManualMovement = z.object({
  type: z.enum(MANUAL_TYPES),
  /** A kit variant means "whole kits": every box is moved (quantity × boxes per kit). */
  variantId: zId,
  quantity: z.number().int().min(1).max(100000),
  fromLocationId: zId.optional(),
  /** Not needed for DAMAGE: it always goes to the Damaged location. */
  toLocationId: zId.optional(),
  /** Required (from a fixed list) for STOCK_IN / STOCK_OUT. */
  reason: z.string().max(100).optional(),
  note: z.string().max(500).optional(),
  reference: z.string().max(100).optional(),
});

const MovementsQuery = z.object({
  productId: zId.optional(),
  variantId: zId.optional(),
  locationId: zId.optional(),
  type: z.enum(MOVEMENT_TYPES).optional(),
  page: zQueryInt(1, 100000).optional(),
  pageSize: zQueryInt(1, 100).optional(),
});

/** The fixed reason lists, for the add/remove forms. */
router.get("/reasons", allow(STOCK_READ), (req, res) => res.json({ add: ADD_REASONS, remove: REMOVE_REASONS }));

router.get(
  "/products/:id",
  allow(STOCK_READ),
  ah(async (req, res) => send(res, await productStock(idParam(req.params.id))))
);

router.get(
  "/low",
  allow(STOCK_READ),
  ah(async (req, res) => send(res, await lowStock()))
);

router.get(
  "/locations/:id",
  allow(STOCK_READ),
  ah(async (req, res) => send(res, await locationStock(idParam(req.params.id))))
);

router.get(
  "/movements",
  allow(STOCK_READ),
  ah(async (req, res) => send(res, await movements(parse(MovementsQuery, req.query))))
);

/** Returns the movements written: one, or one per box for a whole kit. */
router.post(
  "/movements",
  allow(STOCK_WRITE),
  ah(async (req, res) => {
    const dto = parse(ManualMovement, req.body);
    if (dto.type === "ADJUSTMENT" && !STOCK_ADJUST.includes(req.staff.role)) {
      throw forbidden("Only admins and managers can make stock corrections");
    }
    await assertSiteAccess(req.staff, [dto.fromLocationId, dto.toLocationId]);
    send(res, await recordManual(req.staff.id, dto), 201);
  })
);

export default router;
