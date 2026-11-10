// inventory/services/stock.js
// The only place stock changes. Every call:
//  - validates the movements,
//  - updates the touched stock rows and writes the movements in ONE transaction,
//  - updates each row only if it still holds the values it was read with. If another user
//    changed the same row meanwhile, MongoDB reports a write conflict and the whole transaction
//    is retried from a fresh read — so two users can never take the same last unit.
// Pass `session` to make the stock change part of a bigger transaction (a sale, an order…).
import { isDuplicateKey, withTransaction } from "../lib/db.js";
import { badRequest, conflict, HttpError, notFound } from "../lib/http.js";
import { Variant } from "../models/Catalog.js";
import Location from "../models/Location.js";
import { StockLevel, StockMovement } from "../models/Stock.js";
import { systemLocationId, withPaths } from "./locations.js";
import { assertShape, effectsOf, isValidLevel, reasonError, systemLocationError } from "./movementRules.js";

const key = (variantId, locationId) => `${variantId}:${locationId}`;

/**
 * moves: [{ type, variantId, quantity, fromLocationId?, toLocationId?, reason?, note?, reference? }]
 * Returns the movement documents written.
 */
export async function applyMoves(userId, moves, session) {
  if (!moves.length) return [];
  for (const m of moves) {
    try {
      assertShape(m);
    } catch (e) {
      throw badRequest(e.message);
    }
  }
  if (session) return applyIn(session, userId, moves);

  // A brand-new stock row created by two requests at once can hit the unique index; retry once more.
  for (let attempt = 1; ; attempt++) {
    try {
      return await withTransaction((s) => applyIn(s, userId, moves));
    } catch (e) {
      if (attempt < 3 && isDuplicateKey(e, "variantId")) continue;
      throw e;
    }
  }
}

/**
 * A movement entered by a person (add / remove / move / damage / correction).
 * DAMAGE always goes to the Damaged location; a kit variant means whole kits, so each
 * box moves `quantity × per-kit` — all boxes or none.
 */
export async function recordManual(userId, input) {
  const reasonProblem = reasonError(input.type, input.reason, input.note);
  if (reasonProblem) throw badRequest(reasonProblem);

  const toLocationId = input.type === "DAMAGE" ? await systemLocationId("DAMAGED") : input.toLocationId;
  const reason = input.type === "DAMAGE" ? input.reason?.trim() || "Damaged" : input.reason;
  const move = { ...input, toLocationId, reason };

  const variant = await Variant.findById(input.variantId).select("kind components").lean();
  if (!variant) throw notFound("Item not found");
  if (variant.kind !== "KIT") return applyMoves(userId, [move]);

  if (!variant.components?.length) throw badRequest("This kit has no boxes yet");
  return applyMoves(
    userId,
    variant.components.map((c) => ({ ...move, variantId: String(c.componentVariantId), quantity: input.quantity * c.quantity }))
  );
}

async function applyIn(session, userId, moves) {
  const variantIds = [...new Set(moves.map((m) => String(m.variantId)))];
  const variants = await Variant.find({ _id: { $in: variantIds } })
    .select("kind code name productId")
    .populate("productId", "name")
    .session(session)
    .lean();
  const variantById = new Map(variants.map((v) => [String(v._id), v]));

  const locationIds = [
    ...new Set(moves.flatMap((m) => [m.fromLocationId, m.toLocationId]).filter(Boolean).map(String)),
  ];
  const locations = await Location.find({ _id: { $in: locationIds } }).select("type name active").session(session).lean();
  const locationById = new Map(locations.map((l) => [String(l._id), l]));
  const withChildren = new Set(
    (
      await Location.find({ parentId: { $in: locationIds }, active: true }).session(session).distinct("parentId")
    ).map(String)
  );

  for (const m of moves) {
    const variant = variantById.get(String(m.variantId));
    if (!variant) throw notFound("Item not found");
    if (variant.kind === "KIT") {
      throw badRequest(`${variant.productId?.name} is a kit — stock is kept per box, so move its boxes`);
    }
    const from = m.fromLocationId ? locationById.get(String(m.fromLocationId)) : undefined;
    const to = m.toLocationId ? locationById.get(String(m.toLocationId)) : undefined;
    if ((m.fromLocationId && !from) || (m.toLocationId && !to)) throw notFound("Location not found");
    if (to && !to.active) throw badRequest(`"${to.name}" is hidden — stock can't go there`);
    if (to && withChildren.has(String(m.toLocationId))) {
      throw badRequest(`"${to.name}" has spaces inside it — choose the exact space`);
    }
    const systemError = systemLocationError(m.type, from?.type, to?.type);
    if (systemError) throw badRequest(systemError);
  }

  const levels = await loadLevels(session, moves);

  for (const m of moves) {
    for (const effect of effectsOf(m)) {
      const level = levels.get(key(String(m.variantId), effect.locationId));
      const next = { onHand: level.onHand + effect.onHand, reserved: level.reserved + effect.reserved };
      if (!isValidLevel(next)) {
        throw conflict(await shortageMessage(m, effect, level, variantById.get(String(m.variantId))));
      }
      Object.assign(level, next, { dirty: true });
    }
  }

  for (const level of levels.values()) {
    if (!level.dirty) continue;
    const result = await StockLevel.updateOne(
      { _id: level._id, onHand: level.readOnHand, reserved: level.readReserved },
      { $set: { onHand: level.onHand, reserved: level.reserved } },
      { session }
    );
    if (result.matchedCount !== 1) {
      throw new HttpError(409, "Stock changed while saving — please try again");
    }
  }

  return StockMovement.insertMany(
    moves.map((m) => ({
      type: m.type,
      variantId: m.variantId,
      quantity: m.quantity,
      fromLocationId: m.fromLocationId ?? null,
      toLocationId: m.toLocationId ?? null,
      userId: userId ?? null,
      reason: m.reason?.trim() || null,
      note: m.note?.trim() || null,
      reference: m.reference?.trim() || null,
    })),
    { session }
  );
}

/** Creates any missing stock rows, then reads every touched row inside the transaction. */
async function loadLevels(session, moves) {
  const pairs = new Map();
  for (const m of moves) {
    for (const e of effectsOf(m)) {
      pairs.set(key(String(m.variantId), e.locationId), { variantId: String(m.variantId), locationId: e.locationId });
    }
  }
  const wanted = [...pairs.values()];
  await StockLevel.bulkWrite(
    wanted.map((p) => ({
      updateOne: { filter: p, update: { $setOnInsert: { onHand: 0, reserved: 0 } }, upsert: true },
    })),
    { session }
  );
  const rows = await StockLevel.find({ $or: wanted }).session(session).lean();
  return new Map(
    rows.map((r) => [
      key(String(r.variantId), String(r.locationId)),
      { ...r, readOnHand: r.onHand, readReserved: r.reserved },
    ])
  );
}

async function shortageMessage(m, effect, level, variant) {
  const item = `${variant.productId?.name}${variant.name === "Default" ? "" : ` – ${variant.name}`} (${variant.code})`;
  const path = (await withPaths()).find((l) => l.id === effect.locationId)?.path ?? "that location";
  const available = level.onHand - level.reserved;

  if (effect.reserved > 0) return `Only ${available} of ${item} free to reserve at ${path}`;
  if (effect.reserved < 0) {
    return `Only ${level.reserved} of ${item} reserved at ${path}` + (effect.onHand < 0 ? " — reserve it for the order first" : "");
  }
  return (
    `Not enough ${item} at ${path}: ${available} available, ${m.quantity} needed` +
    (level.reserved > 0 ? ` (another ${level.reserved} reserved for orders)` : "")
  );
}
