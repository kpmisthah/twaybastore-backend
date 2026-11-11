// inventory/services/stocktakes.js — count a location; an admin/manager approves the differences.
import mongoose from "mongoose";
import { nextCounter, withTransaction } from "../lib/db.js";
import { badRequest, conflict, notFound } from "../lib/http.js";
import { lockDoc, userRefs, variantRefs } from "../lib/refs.js";
import { Variant } from "../models/Catalog.js";
import { StockLevel } from "../models/Stock.js";
import { Stocktake, StocktakeLine } from "../models/Transfer.js";
import { audit } from "./audit.js";
import { assertSiteAccess, withPaths } from "./locations.js";
import { SYSTEM_TYPES, withDescendants } from "./locationTree.js";
import { applyMoves } from "./stock.js";

const s = (v) => (v == null ? v : String(v));
const OPEN = ["COUNTING", "SUBMITTED"];
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
const pairKey = (variantId, locationId) => `${variantId}:${locationId}`;

export const stocktakeCode = (n) => `ST-${String(n).padStart(6, "0")}`;

function scope(all, locationId) {
  return withDescendants(all, [locationId]).filter((l) => !SYSTEM_TYPES.includes(l.type));
}

/** Visible locations with nothing visible inside — where stock actually sits. */
function countable(all, locationId) {
  const parents = new Set(all.filter((l) => l.active && l.parentId).map((l) => l.parentId));
  return scope(all, locationId).filter((l) => l.active && !parents.has(l.id));
}

async function onHandOf(variantId, locationId, session) {
  const level = await StockLevel.findOne({ variantId, locationId }).select("onHand").session(session ?? null).lean();
  return level?.onHand ?? 0;
}

/** Starts a count of a location: the expected list is everything on hand there right now. */
export async function createStocktake(user, dto) {
  const all = await withPaths();
  const location = all.find((l) => l.id === dto.locationId);
  if (!location) throw notFound("Location not found");
  await assertSiteAccess(user, [location.id]);
  if (SYSTEM_TYPES.includes(location.type)) throw badRequest(`${location.name} can't be stocktaken`);
  if (!location.active) throw badRequest(`${location.name} is hidden`);
  const mine = scope(all, location.id);

  // Two counts of the same shelf at once would fight over the same stock.
  const open = await Stocktake.find({ status: { $in: OPEN } }).select("code locationId").lean();
  for (const o of open) {
    const theirs = new Set(scope(all, s(o.locationId)).map((l) => l.id));
    if (mine.some((l) => theirs.has(l.id)) || theirs.has(location.id)) {
      const path = all.find((l) => l.id === s(o.locationId))?.path ?? "an overlapping location";
      throw conflict(`${o.code} is already counting ${path} — finish or cancel it first`);
    }
  }

  const levels = await StockLevel.find({ locationId: { $in: mine.map((l) => l.id) }, onHand: { $gt: 0 } })
    .select("variantId locationId onHand")
    .lean();

  const id = await withTransaction(async (session) => {
    const number = await nextCounter("stocktake", session);
    const [st] = await Stocktake.create(
      [{ number, code: stocktakeCode(number), locationId: location.id, note: dto.note?.trim() || null, createdById: user.id }],
      { session }
    );
    if (levels.length) {
      await StocktakeLine.insertMany(
        levels.map((l) => ({ stocktakeId: st._id, variantId: l.variantId, locationId: l.locationId, expected: l.onHand })),
        { session }
      );
    }
    await audit(
      { userId: user.id, action: "STOCKTAKE_STARTED", entity: "Stocktake", entityId: st._id, data: { code: st.code, location: location.path } },
      session
    );
    return st._id;
  });
  return getStocktake(id);
}

export async function getStocktake(id) {
  const st = await Stocktake.findById(id).lean();
  if (!st) throw notFound("Stocktake not found");
  const rows = await StocktakeLine.find({ stocktakeId: id }).lean();

  const all = await withPaths();
  const byId = new Map(all.map((l) => [l.id, l]));
  // Live stock, so the screen shows differences against what the system holds now.
  const levels = rows.length
    ? await StockLevel.find({ $or: rows.map((l) => ({ variantId: l.variantId, locationId: l.locationId })) })
        .select("variantId locationId onHand")
        .lean()
    : [];
  const current = new Map(levels.map((l) => [pairKey(l.variantId, l.locationId), l.onHand]));
  const [variants, users] = await Promise.all([
    variantRefs(rows.map((l) => l.variantId)),
    userRefs([st.createdById, st.submittedById, st.approvedById]),
  ]);

  const lines = rows
    .map((l) => {
      const onHand = l.onHandAtApproval ?? current.get(pairKey(l.variantId, l.locationId)) ?? 0;
      return {
        id: s(l._id),
        variantId: s(l.variantId),
        locationId: s(l.locationId),
        expected: l.expected,
        counted: l.counted,
        onHandAtCount: l.onHandAtCount,
        onHandAtApproval: l.onHandAtApproval,
        adjustment: l.adjustment,
        countedAt: l.countedAt,
        path: byId.get(s(l.locationId))?.path ?? "?",
        onHand,
        variance: l.adjustment ?? (l.counted === null ? null : l.counted - (l.onHandAtCount ?? onHand)),
        variant: variants.get(s(l.variantId)) ?? null,
      };
    })
    .sort((a, b) => collator.compare(a.path, b.path) || collator.compare(a.variant?.product.name ?? "", b.variant?.product.name ?? ""));

  return {
    id: s(st._id),
    number: st.number,
    code: st.code,
    status: st.status,
    note: st.note,
    locationId: s(st.locationId),
    createdAt: st.createdAt,
    updatedAt: st.updatedAt,
    submittedAt: st.submittedAt,
    approvedAt: st.approvedAt,
    createdBy: users.get(s(st.createdById)) ?? null,
    submittedBy: users.get(s(st.submittedById)) ?? null,
    approvedBy: users.get(s(st.approvedById)) ?? null,
    location: { id: s(st.locationId), path: byId.get(s(st.locationId))?.path ?? "?" },
    /** Where counts can be entered: stock-holding spaces inside the stocktake's location. */
    spaces: countable(all, s(st.locationId)).map((l) => ({ id: l.id, code: l.code, path: l.path })),
    lines,
  };
}

export async function listStocktakes(query) {
  const items = await Stocktake.find(query.status ? { status: query.status } : {})
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
  const ids = items.map((i) => i._id);
  const [counts, users, all] = await Promise.all([
    StocktakeLine.aggregate([{ $match: { stocktakeId: { $in: ids } } }, { $group: { _id: "$stocktakeId", n: { $sum: 1 } } }]),
    userRefs(items.map((i) => i.createdById)),
    withPaths(),
  ]);
  const countOf = new Map(counts.map((c) => [s(c._id), c.n]));
  const paths = new Map(all.map((l) => [l.id, l.path]));
  return items.map((st) => ({
    id: s(st._id),
    code: st.code,
    status: st.status,
    note: st.note,
    createdAt: st.createdAt,
    locationId: s(st.locationId),
    locationPath: paths.get(s(st.locationId)) ?? "?",
    createdBy: { name: users.get(s(st.createdById))?.name ?? "?" },
    _count: { lines: countOf.get(s(st._id)) ?? 0 },
  }));
}

/** Records a count: either `counted` (set) or `add` (+1 per scan — atomic, so several people can count at once). */
export async function recordCount(user, id, dto) {
  const st = await Stocktake.findById(id).lean();
  if (!st) throw notFound("Stocktake not found");
  if (st.status !== "COUNTING") throw badRequest(`${st.code} is ${st.status.toLowerCase()} — counting is closed`);

  const all = await withPaths();
  const space = countable(all, s(st.locationId)).find((l) => l.id === dto.locationId);
  if (!space) throw badRequest("Choose a space inside the location being counted");
  await assertSiteAccess(user, [space.id]);

  const variant = await Variant.findById(dto.variantId).select("kind productId").populate("productId", "name").lean();
  if (!variant) throw notFound("Item not found");
  if (variant.kind === "KIT") throw badRequest(`${variant.productId?.name} is a kit — count each box`);

  const filter = { stocktakeId: id, variantId: dto.variantId, locationId: dto.locationId };
  // Something found that the system didn't expect here: add a line (expected = what's on record, normally 0).
  const onHandNow = await onHandOf(dto.variantId, dto.locationId);
  try {
    await StocktakeLine.updateOne(filter, { $setOnInsert: { expected: onHandNow } }, { upsert: true });
  } catch (e) {
    if (e?.code !== 11000) throw e; // someone else created it a moment ago
  }
  const stamp = { onHandAtCount: onHandNow, countedById: user.id, countedAt: new Date() };
  if (dto.add !== undefined) {
    await StocktakeLine.updateOne(filter, [
      {
        $set: {
          counted: { $max: [{ $add: [{ $ifNull: ["$counted", 0] }, dto.add] }, 0] },
          onHandAtCount: onHandNow,
          countedById: new mongoose.Types.ObjectId(user.id),
          countedAt: "$$NOW",
        },
      },
    ]);
  } else {
    await StocktakeLine.updateOne(filter, { $set: { counted: dto.counted, ...stamp } });
  }
  const line = await StocktakeLine.findOne(filter).lean();
  return { ...line, id: s(line._id) };
}

export async function submitStocktake(user, id, uncountedAsZero) {
  const st = await mustBe(id, ["COUNTING"]);
  const uncounted = await StocktakeLine.countDocuments({ stocktakeId: id, counted: null });
  if (uncounted && !uncountedAsZero) {
    throw badRequest(`${uncounted} item(s) not counted yet — count them, or confirm they were not found`);
  }
  await withTransaction(async (session) => {
    const locked = await lockDoc(Stocktake, id, session, "Stocktake");
    if (locked.status !== "COUNTING") throw badRequest(`${locked.code} is ${locked.status.toLowerCase()}`);
    // "Not found" items count as 0 against what the system holds now.
    const missing = await StocktakeLine.find({ stocktakeId: id, counted: null }).session(session).lean();
    for (const line of missing) {
      await StocktakeLine.updateOne(
        { _id: line._id },
        { $set: { counted: 0, onHandAtCount: await onHandOf(line.variantId, line.locationId, session), countedById: user.id, countedAt: new Date() } },
        { session }
      );
    }
    await Stocktake.updateOne({ _id: id }, { $set: { status: "SUBMITTED", submittedById: user.id, submittedAt: new Date() } }, { session });
    await audit(
      { userId: user.id, action: "STOCKTAKE_SUBMITTED", entity: "Stocktake", entityId: id, data: { code: st.code, uncountedAsZero: uncounted } },
      session
    );
  });
  return getStocktake(id);
}

/**
 * Applies the differences as ADJUSTMENT movements. Each difference is counted − what the system
 * held when that item was counted, applied to today's stock — so a chair sold after it was
 * counted is not "found" again.
 */
export async function approveStocktake(user, id) {
  await withTransaction(async (session) => {
    const st = await lockDoc(Stocktake, id, session, "Stocktake");
    if (st.status !== "SUBMITTED") throw badRequest(`${st.code} must be submitted before approval`);

    const lines = await StocktakeLine.find({ stocktakeId: id }).session(session).lean();
    const levels = lines.length
      ? await StockLevel.find({ $or: lines.map((l) => ({ variantId: l.variantId, locationId: l.locationId })) })
          .select("variantId locationId onHand")
          .session(session)
          .lean()
      : [];
    const onHand = new Map(levels.map((l) => [pairKey(l.variantId, l.locationId), l.onHand]));
    const moves = [];
    const updates = [];
    for (const line of lines) {
      const now = onHand.get(pairKey(line.variantId, line.locationId)) ?? 0;
      const adjustment = (line.counted ?? 0) - (line.onHandAtCount ?? line.expected);
      updates.push({ updateOne: { filter: { _id: line._id }, update: { $set: { onHandAtApproval: now, adjustment } } } });
      if (adjustment !== 0) {
        moves.push({
          type: "ADJUSTMENT",
          variantId: s(line.variantId),
          quantity: Math.abs(adjustment),
          ...(adjustment > 0 ? { toLocationId: s(line.locationId) } : { fromLocationId: s(line.locationId) }),
          reason: "Stocktake",
          reference: st.code,
        });
      }
    }
    if (updates.length) await StocktakeLine.bulkWrite(updates, { session });
    await applyMoves(user.id, moves, session);
    await Stocktake.updateOne({ _id: id }, { $set: { status: "APPROVED", approvedById: user.id, approvedAt: new Date() } }, { session });
    await audit(
      { userId: user.id, action: "STOCKTAKE_APPROVED", entity: "Stocktake", entityId: id, data: { code: st.code, adjustments: moves.length } },
      session
    );
  });
  return getStocktake(id);
}

/** Send back for recounting. */
export async function reopenStocktake(user, id) {
  const st = await mustBe(id, ["SUBMITTED"]);
  await Stocktake.updateOne({ _id: id, status: "SUBMITTED" }, { $set: { status: "COUNTING", submittedById: null, submittedAt: null } });
  await audit({ userId: user.id, action: "STOCKTAKE_REOPENED", entity: "Stocktake", entityId: id, data: { code: st.code } });
  return getStocktake(id);
}

export async function cancelStocktake(user, id) {
  const st = await mustBe(id, OPEN);
  await Stocktake.updateOne({ _id: id, status: { $in: OPEN } }, { $set: { status: "CANCELLED" } });
  await audit({ userId: user.id, action: "STOCKTAKE_CANCELLED", entity: "Stocktake", entityId: id, data: { code: st.code } });
  return getStocktake(id);
}

async function mustBe(id, statuses) {
  const st = await Stocktake.findById(id).lean();
  if (!st) throw notFound("Stocktake not found");
  if (!statuses.includes(st.status)) throw badRequest(`${st.code} is ${st.status.toLowerCase()}`);
  return st;
}
