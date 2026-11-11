import { verifyApprover } from "../auth/approver.js";
import { nextCounter, withTransaction } from "../lib/db.js";
import { badRequest, conflict, HttpError, notFound } from "../lib/http.js";
import { lockDoc, m2, userRefs, variantRefs } from "../lib/refs.js";
import { escapeRegex } from "../lib/validate.js";
import { Barcode, Variant } from "../models/Catalog.js";
import { StockLevel } from "../models/Stock.js";
import { Order } from "../models/Order.js";
import { audit } from "./audit.js";
import { assertSiteAccess, systemLocationId, withPaths } from "./locations.js";
import { SYSTEM_TYPES } from "./locationTree.js";
import { applyMoves } from "./stock.js";

const s = (v) => (v == null ? v : String(v));
const sum = (rows, f) => rows.reduce((t, r) => t + f(r), 0);

export const EDITABLE = ["NEW", "ALLOCATED", "PICKING"];
const PICKABLE = ["ALLOCATED", "PICKING"];
const CANCELLABLE = ["NEW", "ALLOCATED", "PICKING", "LOADED", "OUT_FOR_DELIVERY", "FAILED"];
/** Loaded stock still on the van for these orders must be scanned back into stock. */
export const RETURNABLE = ["CANCELLED", "FAILED", "DELIVERED"];
/** Not finished yet (a driver's to-do list). */
export const OPEN_STATUSES = ["NEW", "ALLOCATED", "PICKING", "LOADED", "OUT_FOR_DELIVERY", "FAILED"];

/** Units of an allocation that are on the van right now. */
export const inTransitOf = (a) => a.picked - a.delivered - a.returned;

export const orderNumber = (n) => `ORD-${String(n).padStart(6, "0")}`;

/** Drivers may only see and work on orders assigned to them (404, so other orders aren't revealed). */
export function assertCanSee(user, order) {
  if (user?.role === "DRIVER" && s(order.driverId) !== user.id) throw notFound("Order not found");
}

/** Locks the order for the rest of the transaction and returns it. */
export async function lockOrder(session, id, user) {
  const order = await lockDoc(Order, id, session, "Order");
  if (user) assertCanSee(user, order);
  return order;
}

/** Display name: "Chair – Red", "Wardrobe, Box A", or the product name. */
export function itemName(v) {
  const product = v.product?.name ?? v.productId?.name ?? "?";
  if (v.kind === "STANDARD" && v.name !== "Default") return `${product} – ${v.name}`;
  if (v.kind === "COMPONENT") return `${product}, ${v.name.split(" – ")[0]}`;
  return product;
}

// ---------------------------------------------------------------- create / read

/**
 * dto: { customerName, lines: [{ variantId, quantity }], customerPhone?, address?, latitude?, longitude?,
 * notes?, paymentStatus?, codAmount?, deliveryDate?, timeWindow? }
 */
export async function createOrder(user, dto, source = "MANUAL", externalId = null, prices = []) {
  const variants = await Variant.find({ _id: { $in: dto.lines.map((l) => l.variantId) } })
    .select("kind code name active productId")
    .populate("productId", "name status")
    .lean();
  const byId = new Map(variants.map((v) => [s(v._id), v]));
  for (const l of dto.lines) {
    const v = byId.get(l.variantId);
    if (!v) throw notFound("One of the items no longer exists");
    if (v.kind === "COMPONENT") throw badRequest(`${itemName(v)}: order the whole kit, not one box`);
    if (!v.active || v.productId?.status === "INACTIVE") throw badRequest(`${itemName(v)} is inactive`);
  }

  const id = await withTransaction(async (session) => {
    const number = await nextCounter("order", session);
    const [created] = await Order.create(
      [
        {
          number,
          orderNumber: orderNumber(number),
          source,
          externalId: externalId ?? null,
          ...details(dto),
          customerName: dto.customerName.trim(),
          createdById: user?.id ?? null,
          lines: dto.lines.map((l, i) => ({
            lineNo: i + 1,
            variantId: l.variantId,
            description: itemName(byId.get(l.variantId)),
            quantity: l.quantity,
            unitPrice: prices[i] ?? null,
          })),
        },
      ],
      { session }
    );
    await audit(
      {
        userId: user?.id ?? null,
        action: "ORDER_CREATED",
        entity: "Order",
        entityId: created._id,
        data: { orderNumber: created.orderNumber, source, externalId },
      },
      session
    );
    return created._id;
  });
  return getOrder(id);
}

/** Pass `user` to apply the driver rule: drivers only see orders assigned to them. */
export async function getOrder(id, user) {
  const order = await Order.findById(id).lean();
  if (!order) throw notFound("Order not found");
  if (user) assertCanSee(user, order);

  const variantIds = [
    ...order.lines.map((l) => l.variantId),
    ...order.allocations.map((a) => a.variantId),
    ...order.exceptions.map((e) => e.variantId),
  ];
  const [all, refs, users, kitParts] = await Promise.all([
    withPaths(),
    variantRefs(variantIds),
    userRefs([
      order.driverId,
      order.createdById,
      order.shortApprovedById,
      order.deliveredById,
      order.partialApprovedById,
      ...order.exceptions.map((e) => e.reportedById),
    ]),
    kitComponents(order.lines.map((l) => l.variantId)),
  ]);
  const byId = new Map(all.map((l) => [l.id, l]));
  const user_ = (uid) => users.get(s(uid)) ?? null;

  const allocations = order.allocations.map((a) => {
    const loc = byId.get(s(a.locationId));
    return {
      id: s(a._id),
      lineId: s(a.lineId),
      variantId: s(a.variantId),
      locationId: s(a.locationId),
      quantity: a.quantity,
      picked: a.picked,
      released: a.released,
      delivered: a.delivered,
      returned: a.returned,
      path: loc?.path ?? "?",
      site: loc?.pathNames[0] ?? "?",
      locationCode: loc?.code ?? "",
      variant: refs.get(s(a.variantId)) ?? null,
    };
  });
  const loaded = sum(allocations, inTransitOf);
  const lines = order.lines.map((l) => ({
    id: s(l._id),
    lineNo: l.lineNo,
    variantId: s(l.variantId),
    description: l.description,
    quantity: l.quantity,
    unitPrice: m2(l.unitPrice),
    variant: refs.get(s(l.variantId)) ?? null,
  }));

  return {
    id: s(order._id),
    number: order.number,
    orderNumber: order.orderNumber,
    source: order.source,
    externalId: order.externalId,
    status: order.status,
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    address: order.address,
    latitude: order.latitude,
    longitude: order.longitude,
    notes: order.notes,
    paymentStatus: order.paymentStatus,
    codAmount: m2(order.codAmount),
    deliveryDate: order.deliveryDate,
    timeWindow: order.timeWindow,
    shortReason: order.shortReason,
    cancelReason: order.cancelReason,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    driverId: s(order.driverId) ?? null,
    driver: user_(order.driverId),
    createdBy: user_(order.createdById),
    shortApprovedBy: user_(order.shortApprovedById),
    startedAt: order.startedAt,
    deliveredAt: order.deliveredAt,
    deliveredBy: user_(order.deliveredById),
    recipientName: order.recipientName,
    codCollected: m2(order.codCollected),
    deliveryNote: order.deliveryNote,
    deliveryPhotoUrl: order.deliveryPhotoUrl,
    partialApprovedBy: user_(order.partialApprovedById),
    failedReason: order.failedReason,
    exceptions: order.exceptions.map((e) => {
      const v = refs.get(s(e.variantId));
      const loc = byId.get(s(e.locationId));
      return {
        id: s(e._id),
        type: e.type,
        note: e.note,
        photoUrl: e.photoUrl,
        createdAt: e.createdAt,
        reportedBy: user_(e.reportedById) ?? { id: s(e.reportedById), name: "?" },
        variant: v ? { id: v.id, code: v.code, name: v.name } : null,
        location: loc ? { id: loc.id, name: loc.name } : null,
      };
    }),
    lines,
    allocations,
    needs: needsOf(order.lines, kitParts).map((n) => {
      const mine = allocations.filter((a) => a.lineId === n.lineId && a.variantId === n.variantId);
      return { ...n, allocated: sum(mine, (a) => a.quantity), picked: sum(mine, (a) => a.picked) };
    }),
    /** Units still In Transit for this order. */
    inTransit: loaded,
    awaitingReturn: RETURNABLE.includes(order.status) && loaded > 0,
  };
}

export async function listOrders(query, user) {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 25;
  const q = query.q?.trim();
  const filter = {};
  if (query.status) filter.status = query.status;
  if (query.open) filter.status = { $in: OPEN_STATUSES };
  if (query.deliveredSince) {
    filter.status = "DELIVERED";
    filter.deliveredAt = { $gte: new Date(query.deliveredSince) };
  }
  // Drivers only ever see their own deliveries.
  if (user.role === "DRIVER") filter.driverId = user.id;
  else if (query.driverId) filter.driverId = query.driverId;
  if (q) {
    const rx = new RegExp(escapeRegex(q), "i");
    filter.$or = [{ orderNumber: rx }, { externalId: rx }, { customerName: rx }, { customerPhone: rx }];
  }

  // Open lists: soonest delivery first, undated last.
  const sort = query.open ? { hasDate: -1, deliveryDate: 1, createdAt: 1 } : { createdAt: -1 };
  const [rows, total] = await Promise.all([
    Order.aggregate([
      { $match: castIds(filter) },
      { $addFields: { hasDate: { $cond: [{ $ifNull: ["$deliveryDate", false] }, 1, 0] } } },
      { $sort: sort },
      { $skip: (page - 1) * pageSize },
      { $limit: pageSize },
      { $project: { exceptions: 0, lines: { description: 0 } } },
    ]),
    Order.countDocuments(filter),
  ]);
  // Where the driver still has to collect from, and how much is on the van.
  const [all, users] = await Promise.all([withPaths(), userRefs(rows.map((o) => o.driverId))]);
  const sites = new Map(all.map((l) => [l.id, l.pathNames[0]]));
  const items = rows.map((o) => {
    const pickups = new Map();
    for (const a of o.allocations) {
      const left = a.quantity - a.picked - a.released;
      const site = sites.get(s(a.locationId)) ?? "?";
      if (left > 0) pickups.set(site, (pickups.get(site) ?? 0) + left);
    }
    return {
      id: s(o._id),
      orderNumber: o.orderNumber,
      source: o.source,
      externalId: o.externalId,
      status: o.status,
      customerName: o.customerName,
      customerPhone: o.customerPhone,
      address: o.address,
      deliveryDate: o.deliveryDate,
      timeWindow: o.timeWindow,
      paymentStatus: o.paymentStatus,
      codAmount: m2(o.codAmount),
      createdAt: o.createdAt,
      deliveredAt: o.deliveredAt,
      driverId: s(o.driverId) ?? null,
      driver: users.get(s(o.driverId)) ?? null,
      _count: { lines: o.lines.length },
      pickups: [...pickups].map(([site, n]) => ({ site, items: n })),
      inTransit: sum(o.allocations, inTransitOf),
    };
  });
  return { items, total, page, pageSize };
}

/** aggregate() doesn't cast like find() does. */
function castIds(filter) {
  if (!filter.driverId) return filter;
  return { ...filter, driverId: new Order.base.Types.ObjectId(String(filter.driverId)) };
}

export async function updateOrder(user, id, dto) {
  const order = await mustBe(id, EDITABLE);
  const changes = details(dto);
  if (dto.customerName) changes.customerName = dto.customerName.trim();
  await Order.updateOne({ _id: id }, { $set: changes });
  await audit({ userId: user.id, action: "ORDER_UPDATED", entity: "Order", entityId: id, data: { orderNumber: order.orderNumber, changes: dto } });
  return getOrder(id);
}

// ---------------------------------------------------------------- allocation

/**
 * Suggests where to take each item from. Sites that can cover more of the order come first,
 * so drivers visit as few sites as possible; within a site, the fullest spaces first.
 * needs: [{ lineId, variantId, quantity }], sources: [{ variantId, locationId, site, path, available }]
 */
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
export function suggestAllocation(needs, sources) {
  const left = new Map(sources.map((x) => [`${x.variantId}:${x.locationId}`, x.available]));

  // How much of the order each site could supply.
  const wanted = new Map();
  for (const n of needs) wanted.set(n.variantId, (wanted.get(n.variantId) ?? 0) + n.quantity);
  const perSiteVariant = new Map();
  for (const x of sources) {
    const key = `${x.site}\u0000${x.variantId}`;
    perSiteVariant.set(key, (perSiteVariant.get(key) ?? 0) + x.available);
  }
  const siteCover = new Map();
  for (const [key, available] of perSiteVariant) {
    const [site, variantId] = key.split("\u0000");
    siteCover.set(site, (siteCover.get(site) ?? 0) + Math.min(available, wanted.get(variantId) ?? 0));
  }
  const siteRank = (site) => -(siteCover.get(site) ?? 0);

  const allocations = [];
  const short = [];
  for (const need of needs) {
    let remaining = need.quantity;
    const candidates = sources
      .filter((x) => x.variantId === need.variantId)
      .sort(
        (a, b) =>
          siteRank(a.site) - siteRank(b.site) || collator.compare(a.site, b.site) || b.available - a.available || collator.compare(a.path, b.path)
      );
    for (const x of candidates) {
      if (remaining === 0) break;
      const key = `${x.variantId}:${x.locationId}`;
      const take = Math.min(remaining, left.get(key) ?? 0);
      if (take <= 0) continue;
      left.set(key, (left.get(key) ?? 0) - take);
      allocations.push({ lineId: need.lineId, variantId: need.variantId, locationId: x.locationId, quantity: take });
      remaining -= take;
    }
    if (remaining > 0) short.push({ ...need, missing: remaining });
  }
  return { allocations, short };
}

/** Checks a confirmed allocation covers every need exactly. Returns an error message or null. */
export function allocationProblem(needs, allocations) {
  const got = new Map();
  for (const a of allocations) {
    if (!Number.isInteger(a.quantity) || a.quantity <= 0) return "Each allocation needs a quantity above 0";
    const key = `${a.lineId}:${a.variantId}`;
    got.set(key, (got.get(key) ?? 0) + a.quantity);
  }
  const needed = new Set(needs.map((n) => `${n.lineId}:${n.variantId}`));
  if ([...got.keys()].some((k) => !needed.has(k))) return "An allocation is for an item that is not on the order";
  for (const n of needs) {
    const have = got.get(`${n.lineId}:${n.variantId}`) ?? 0;
    if (have !== n.quantity) return `${n.name}: ${have} allocated but ${n.quantity} needed`;
  }
  return null;
}

/** Where the system would take each item from (not saved). */
export async function suggestForOrder(id) {
  const order = await Order.findById(id).lean();
  if (!order) throw notFound("Order not found");
  const needs = needsOf(order.lines, await kitComponents(order.lines.map((l) => l.variantId)));
  const sources = await freeStock(needs.map((n) => n.variantId));
  const { allocations, short } = suggestAllocation(needs, sources);
  const where = new Map(sources.map((x) => [x.locationId, x]));
  return {
    allocations: allocations.map((a) => ({ ...a, path: where.get(a.locationId)?.path, site: where.get(a.locationId)?.site })),
    short,
    needs,
    /** Every place each needed item is free, so the manager can change the suggestion. */
    sources,
  };
}

/** Confirms the allocation: reserves the stock at those locations. */
export async function allocateOrder(user, id, dto) {
  await withTransaction(async (session) => {
    const order = await lockOrder(session, id, user);
    if (order.status !== "NEW") throw badRequest(`${order.orderNumber} is already ${order.status.toLowerCase()}`);
    const needs = needsOf(order.lines, await kitComponents(order.lines.map((l) => l.variantId), session));
    const problem = allocationProblem(needs, dto.allocations);
    if (problem) throw badRequest(problem);

    const merged = new Map();
    for (const a of dto.allocations) {
      const key = `${a.lineId}:${a.variantId}:${a.locationId}`;
      const m = merged.get(key);
      if (m) m.quantity += a.quantity;
      else merged.set(key, { ...a });
    }
    await applyMoves(
      user.id,
      [...merged.values()].map((a) => ({
        type: "RESERVE",
        variantId: a.variantId,
        quantity: a.quantity,
        fromLocationId: a.locationId,
        reference: order.orderNumber,
      })),
      session
    );
    await Order.updateOne(
      { _id: id },
      { $set: { allocations: [...merged.values()], status: "ALLOCATED" } },
      { session }
    );
    await audit(
      { userId: user.id, action: "ORDER_ALLOCATED", entity: "Order", entityId: id, data: { orderNumber: order.orderNumber, allocations: merged.size } },
      session
    );
  });
  return getOrder(id);
}

/** Gives the reservations back so the allocation can be redone (only before picking starts). */
export async function unallocateOrder(user, id) {
  await withTransaction(async (session) => {
    const order = await lockOrder(session, id, user);
    if (order.status !== "ALLOCATED") throw badRequest("Only an allocated order that has not been picked can be re-allocated");
    await applyMoves(
      user.id,
      order.allocations.map((a) => ({
        type: "RELEASE",
        variantId: s(a.variantId),
        quantity: a.quantity,
        fromLocationId: s(a.locationId),
        reference: order.orderNumber,
      })),
      session
    );
    await Order.updateOne({ _id: id }, { $set: { allocations: [], status: "NEW" } }, { session });
    await audit({ userId: user.id, action: "ORDER_UNALLOCATED", entity: "Order", entityId: id, data: { orderNumber: order.orderNumber } }, session);
  });
  return getOrder(id);
}

// ---------------------------------------------------------------- picking

/** WRONG_LOCATION | ALREADY_PICKED | WRONG_ITEM | WRONG_BOX | UNKNOWN_CODE | NOT_PICKABLE | OTHER */
function pickErrorReason(e) {
  if (e.extra?.code) return String(e.extra.code);
  if (e.status === 404) return "UNKNOWN_CODE";
  if (e.message.startsWith("Wrong item")) return "WRONG_ITEM";
  if (e.message.startsWith("Wrong box")) return "WRONG_BOX";
  if (e.message.includes("nothing to pick")) return "NOT_PICKABLE";
  return "OTHER";
}

/**
 * One scan = one unit picked and loaded (reserved → In Transit). Checks the right item / box,
 * the right location and not more than ordered. A different location needs a manager.
 * dto: { code, locationId, approval?, reason? }
 */
export async function pickItem(user, id, dto) {
  await assertSiteAccess(user, [dto.locationId]);
  try {
    return await pickOnce(user, id, dto);
  } catch (e) {
    // Wrong item / box / place or too many: keep a record for the picking-errors report.
    // (Logged outside the failed transaction, which rolls back.)
    if (e instanceof HttpError && [400, 404, 409].includes(e.status)) {
      const order = await Order.findById(id).select("orderNumber driverId").lean();
      if (order && (user.role !== "DRIVER" || s(order.driverId) === user.id)) {
        await audit({
          userId: user.id,
          action: "PICK_REJECTED",
          entity: "Order",
          entityId: id,
          data: { orderNumber: order.orderNumber, code: dto.code.trim(), locationId: dto.locationId, reason: pickErrorReason(e), message: e.message },
        });
      }
    }
    throw e;
  }
}

async function pickOnce(user, id, dto) {
  // The approver's password is checked before the transaction (bcrypt is slow, and retries would repeat it).
  const approval = dto.approval ? await verifyApprover(dto.approval).catch((e) => e) : null;
  const result = await withTransaction(async (session) => {
    const order = await lockOrder(session, id, user);
    if (!PICKABLE.includes(order.status)) throw badRequest(`${order.orderNumber} is ${order.status.toLowerCase()} — nothing to pick`);

    const barcode = await Barcode.findOne({ code: dto.code.trim(), active: true }).session(session).lean();
    if (!barcode) throw notFound(`Unknown code "${dto.code.trim()}"`);
    const v = (await variantRefs([barcode.variantId], session)).get(s(barcode.variantId));
    if (!v) throw notFound(`Unknown code "${dto.code.trim()}"`);
    const name = itemName(v);
    const forItem = order.allocations.filter((a) => s(a.variantId) === v.id);
    if (!forItem.length) {
      throw badRequest(v.kind === "COMPONENT" ? `Wrong box: ${name} is not part of this order` : `Wrong item: ${name} is not on this order`);
    }
    const open = forItem.filter((a) => a.picked + a.released < a.quantity);
    if (!open.length) throw conflict(`All ${sum(forItem, (a) => a.picked)} × ${name} already picked`, { code: "ALREADY_PICKED" });

    const transitId = await systemLocationId("TRANSIT", session);
    const paths = new Map((await withPaths(session)).map((l) => [l.id, l.path]));
    const here = open.find((a) => s(a.locationId) === dto.locationId);
    const allocations = order.allocations.map((a) => ({ ...a }));
    let override = false;

    if (here) {
      await applyMoves(
        user.id,
        [{ type: "LOAD", variantId: v.id, quantity: 1, fromLocationId: dto.locationId, toLocationId: transitId, reference: order.orderNumber }],
        session
      );
      allocations.find((a) => s(a._id) === s(here._id)).picked += 1;
    } else {
      const expected = [...new Set(open.map((a) => paths.get(s(a.locationId)) ?? "?"))].join(" or ");
      if (!approval) throw conflict(`Wrong location: ${name} should be picked from ${expected}`, { code: "WRONG_LOCATION", expected });
      if (approval instanceof Error) throw approval;
      if (!dto.reason?.trim()) throw badRequest("Give a reason for picking from a different location");
      const approverId = approval;
      const from = open[0];
      // Move the reservation to where it was actually found, then load from there.
      await applyMoves(
        user.id,
        [
          { type: "RELEASE", variantId: v.id, quantity: 1, fromLocationId: s(from.locationId), reference: order.orderNumber },
          { type: "RESERVE", variantId: v.id, quantity: 1, fromLocationId: dto.locationId, reference: order.orderNumber },
          {
            type: "LOAD",
            variantId: v.id,
            quantity: 1,
            fromLocationId: dto.locationId,
            toLocationId: transitId,
            reference: order.orderNumber,
            reason: "Picked from a different location",
            note: dto.reason,
          },
        ],
        session
      );
      const fromRow = allocations.find((a) => s(a._id) === s(from._id));
      fromRow.quantity -= 1;
      const existing = allocations.find((a) => s(a.lineId) === s(from.lineId) && s(a.variantId) === v.id && s(a.locationId) === dto.locationId);
      if (existing) {
        existing.quantity += 1;
        existing.picked += 1;
      } else {
        allocations.push({ lineId: from.lineId, variantId: v.id, locationId: dto.locationId, quantity: 1, picked: 1, released: 0, delivered: 0, returned: 0 });
      }
      override = true;
      await audit(
        {
          userId: user.id,
          action: "PICK_LOCATION_OVERRIDE",
          entity: "Order",
          entityId: id,
          data: {
            orderNumber: order.orderNumber,
            item: name,
            expectedFrom: paths.get(s(from.locationId)) ?? "?",
            pickedFrom: paths.get(dto.locationId) ?? "?",
            approvedById: approverId,
            reason: dto.reason,
          },
        },
        session
      );
    }

    const kept = allocations.filter((a) => a.quantity > 0);
    const done = kept.every((a) => a.picked + a.released >= a.quantity);
    await Order.updateOne({ _id: id }, { $set: { allocations: kept, status: done ? "LOADED" : "PICKING" } }, { session });
    const left = sum(
      kept.filter((a) => s(a.variantId) === v.id),
      (a) => a.quantity - a.picked - a.released
    );
    return { item: name, from: paths.get(dto.locationId) ?? "?", leftOfThisItem: left, override };
  });
  return { ...result, order: await getOrder(id) };
}

/** Manager override: finish with some items/boxes not picked (their reservations are released). */
export async function shortPick(user, id, dto) {
  const approverId = await verifyApprover(dto.approval);
  await withTransaction(async (session) => {
    const order = await lockOrder(session, id, user);
    if (!PICKABLE.includes(order.status)) throw badRequest(`${order.orderNumber} is ${order.status.toLowerCase()}`);
    if (!order.allocations.some((a) => a.picked > 0)) throw badRequest("Nothing has been picked — cancel the order instead");
    const { allocations, missing } = await releaseUnpicked(session, user.id, order, "Approved as missing");
    await Order.updateOne(
      { _id: id },
      { $set: { allocations, status: "LOADED", shortReason: dto.reason.trim(), shortApprovedById: approverId } },
      { session }
    );
    await audit(
      {
        userId: user.id,
        action: "ORDER_SHORT_APPROVED",
        entity: "Order",
        entityId: id,
        data: { orderNumber: order.orderNumber, missing, approvedById: approverId, reason: dto.reason },
      },
      session
    );
  });
  return getOrder(id);
}

/** Releases reservations. Anything already loaded stays In Transit until scanned back (returnScan). */
export async function cancelOrder(user, id, reason, session) {
  const run = async (tx) => {
    const order = await lockOrder(tx, id, user);
    if (!CANCELLABLE.includes(order.status)) throw badRequest(`${order.orderNumber} is ${order.status.toLowerCase()} and can't be cancelled`);
    const { allocations } = await releaseUnpicked(tx, user?.id ?? null, order, "Order cancelled");
    await Order.updateOne({ _id: id }, { $set: { allocations, status: "CANCELLED", cancelReason: reason.trim() } }, { session: tx });
    await audit({ userId: user?.id ?? null, action: "ORDER_CANCELLED", entity: "Order", entityId: id, data: { orderNumber: order.orderNumber, reason } }, tx);
  };
  if (session) await run(session);
  else await withTransaction(run);
  return getOrder(id);
}

/**
 * Scans a unit still on the van back into stock (Good → a space, Damaged → Damaged): after a
 * cancellation, a failed delivery, or the part of a delivery the customer didn't take.
 * dto: { code, condition, locationId? }
 */
export async function returnScan(user, id, dto) {
  if (dto.condition === "GOOD") await assertSiteAccess(user, [dto.locationId]);
  const result = await withTransaction(async (session) => {
    const order = await lockOrder(session, id, user);
    if (!RETURNABLE.includes(order.status)) {
      throw badRequest(`${order.orderNumber} is ${order.status.toLowerCase()} — returns are for cancelled, failed or partly delivered orders`);
    }
    const barcode = await Barcode.findOne({ code: dto.code.trim(), active: true }).session(session).lean();
    if (!barcode) throw notFound(`Unknown code "${dto.code.trim()}"`);
    const v = (await variantRefs([barcode.variantId], session)).get(s(barcode.variantId));
    const name = itemName(v);
    const allocations = order.allocations.map((a) => ({ ...a }));
    const alloc = allocations.find((a) => s(a.variantId) === s(barcode.variantId) && inTransitOf(a) > 0);
    if (!alloc) throw badRequest(`No loaded ${name} left to return on this order`);
    const to = dto.condition === "DAMAGED" ? await systemLocationId("DAMAGED", session) : dto.locationId;
    if (!to) throw badRequest("Choose where the item goes back to");

    await applyMoves(
      user.id,
      [
        {
          type: "RETURN",
          variantId: s(barcode.variantId),
          quantity: 1,
          fromLocationId: await systemLocationId("TRANSIT", session),
          toLocationId: to,
          reference: order.orderNumber,
          reason: dto.condition === "DAMAGED" ? "Returned damaged" : `Returned (${order.status.toLowerCase()} order)`,
        },
      ],
      session
    );
    alloc.returned += 1;
    const remaining = sum(allocations, inTransitOf);
    const status = remaining === 0 && order.status === "FAILED" ? "RETURNED" : order.status;
    await Order.updateOne({ _id: id }, { $set: { allocations, status } }, { session });
    await audit(
      { userId: user.id, action: "ORDER_ITEM_RETURNED", entity: "Order", entityId: id, data: { orderNumber: order.orderNumber, item: name, condition: dto.condition } },
      session
    );
    return { item: name, remaining };
  });
  return { ...result, order: await getOrder(id) };
}

// ---------------------------------------------------------------- helpers

async function mustBe(id, statuses) {
  const order = await Order.findById(id).lean();
  if (!order) throw notFound("Order not found");
  if (!statuses.includes(order.status)) throw badRequest(`${order.orderNumber} is ${order.status.toLowerCase()}`);
  return order;
}

/** Returns the allocations with open reservations released, and how many units that was. */
async function releaseUnpicked(session, userId, order, reason) {
  const moves = [];
  let missing = 0;
  const allocations = order.allocations.map((a) => {
    const open = a.quantity - a.picked - a.released;
    if (open <= 0) return a;
    missing += open;
    moves.push({ type: "RELEASE", variantId: s(a.variantId), quantity: open, fromLocationId: s(a.locationId), reference: order.orderNumber, reason });
    return { ...a, released: a.released + open };
  });
  await applyMoves(userId, moves, session);
  return { allocations, missing };
}

/** kit variant id → [{ variantId, quantity, name }] for the kits among these variants. */
async function kitComponents(variantIds, session) {
  const kits = await Variant.find({ _id: { $in: variantIds }, kind: "KIT" }).select("components").session(session ?? null).lean();
  const boxIds = kits.flatMap((k) => k.components.map((c) => c.componentVariantId));
  const names = new Map(
    (await Variant.find({ _id: { $in: boxIds } }).select("name").session(session ?? null).lean()).map((b) => [s(b._id), b.name])
  );
  return new Map(
    kits.map((k) => [
      s(k._id),
      k.components.map((c) => ({ variantId: s(c.componentVariantId), quantity: c.quantity, name: names.get(s(c.componentVariantId)) ?? "Box" })),
    ])
  );
}

/** What each line needs reserved: the variant itself, or every box of a kit. */
function needsOf(lines, kitParts) {
  return lines.flatMap((line) => {
    const parts = kitParts.get(s(line.variantId));
    return parts
      ? parts.map((c) => ({
        lineId: s(line._id),
        variantId: c.variantId,
        quantity: c.quantity * line.quantity,
        name: `${line.description}, ${c.name.split(" – ")[0]}`,
      }))
      : [{ lineId: s(line._id), variantId: s(line.variantId), quantity: line.quantity, name: line.description }];
  });
}

/** Free stock for these variants in real, visible locations. */
async function freeStock(variantIds) {
  const levels = await StockLevel.find({ variantId: { $in: [...new Set(variantIds)] } }).lean();
  const all = new Map((await withPaths()).map((l) => [l.id, l]));
  return levels
    .map((l) => ({ l, loc: all.get(s(l.locationId)) }))
    .filter(({ l, loc }) => loc && loc.active && !SYSTEM_TYPES.includes(loc.type) && l.onHand - l.reserved > 0)
    .map(({ l, loc }) => ({
      variantId: s(l.variantId),
      locationId: s(l.locationId),
      site: loc.pathNames[0],
      path: loc.path,
      available: l.onHand - l.reserved,
    }));
}

function details(dto) {
  const out = {};
  const text = (v) => (v === undefined ? undefined : v?.trim() || null);
  const set = (key, value) => {
    if (value !== undefined) out[key] = value;
  };
  set("customerPhone", text(dto.customerPhone));
  set("address", text(dto.address));
  set("latitude", dto.latitude);
  set("longitude", dto.longitude);
  set("notes", text(dto.notes));
  set("paymentStatus", dto.paymentStatus);
  set("codAmount", dto.codAmount);
  set("deliveryDate", dto.deliveryDate ? dto.deliveryDate.slice(0, 10) : dto.deliveryDate === "" ? null : undefined);
  set("timeWindow", text(dto.timeWindow));
  return out;
}

