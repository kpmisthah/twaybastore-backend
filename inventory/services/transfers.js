// inventory/services/transfers.js
// Two-step transfers (client brief §6): send = scan out at the source (stock goes In Transit),
// receive = scan in at the destination. Partial receipts are allowed; what never arrives is
// written off by a manager with a reason.
import { nextCounter, withTransaction } from "../lib/db.js";
import { badRequest, forbidden, notFound } from "../lib/http.js";
import { lockDoc, userRefs, variantRefs } from "../lib/refs.js";
import { Variant } from "../models/Catalog.js";
import { Transfer } from "../models/Transfer.js";
import { audit } from "./audit.js";
import { assertSiteAccess, systemLocationId, withPaths } from "./locations.js";
import { SYSTEM_TYPES } from "./locationTree.js";
import { applyMoves } from "./stock.js";

const s = (v) => (v == null ? v : String(v));
const MANAGERS = ["ADMIN", "MANAGER"];
const sum = (rows, f) => rows.reduce((t, r) => t + f(r), 0);

export const transferCode = (n) => `TR-${String(n).padStart(6, "0")}`;

const pathInfo = (l) => (l ? { id: l.id, path: l.path, siteId: l.siteId } : null);

/** dto: { fromLocationId, toLocationId, lines: [{ variantId, quantity }], note? } */
export async function sendTransfer(user, dto) {
  if (dto.fromLocationId === dto.toLocationId) throw badRequest("Choose a different destination");
  await assertSiteAccess(user, [dto.fromLocationId]);
  const all = await withPaths();
  const parents = new Set(all.filter((l) => l.active && l.parentId).map((l) => l.parentId));
  for (const id of [dto.fromLocationId, dto.toLocationId]) {
    const loc = all.find((l) => l.id === id);
    if (!loc) throw notFound("Location not found");
    if (SYSTEM_TYPES.includes(loc.type)) throw badRequest(`${loc.name} can't be used for a transfer`);
    if (id === dto.toLocationId && (!loc.active || parents.has(loc.id))) {
      throw badRequest(`${loc.path} can't receive stock — choose the exact space`);
    }
  }

  // A whole kit is sent as all of its boxes.
  const variants = await Variant.find({ _id: { $in: dto.lines.map((l) => l.variantId) } })
    .select("kind components")
    .lean();
  const qty = new Map();
  for (const line of dto.lines) {
    const v = variants.find((x) => s(x._id) === line.variantId);
    if (!v) throw notFound("One of the items no longer exists");
    const parts =
      v.kind === "KIT"
        ? v.components.map((c) => ({ id: s(c.componentVariantId), n: c.quantity * line.quantity }))
        : [{ id: s(v._id), n: line.quantity }];
    if (!parts.length) throw badRequest("That kit has no boxes yet");
    for (const p of parts) qty.set(p.id, (qty.get(p.id) ?? 0) + p.n);
  }

  const id = await withTransaction(async (session) => {
    const transitId = await systemLocationId("TRANSIT", session);
    const number = await nextCounter("transfer", session);
    const code = transferCode(number);
    const [created] = await Transfer.create(
      [
        {
          number,
          code,
          fromLocationId: dto.fromLocationId,
          toLocationId: dto.toLocationId,
          note: dto.note?.trim() || null,
          sentById: user.id,
          lines: [...qty].map(([variantId, quantity]) => ({ variantId, quantity })),
        },
      ],
      { session }
    );
    await applyMoves(
      user.id,
      [...qty].map(([variantId, quantity]) => ({
        type: "TRANSFER_OUT",
        variantId,
        quantity,
        fromLocationId: dto.fromLocationId,
        toLocationId: transitId,
        reference: code,
        note: dto.note,
      })),
      session
    );
    await audit(
      { userId: user.id, action: "TRANSFER_SENT", entity: "StockTransfer", entityId: created._id, data: { code, units: sum([...qty.values()], (n) => n) } },
      session
    );
    return created._id;
  });
  return getTransfer(id);
}

/** Scanned in at the destination. Anything not yet received stays In Transit. */
export async function receiveTransfer(user, id, dto) {
  await withTransaction(async (session) => {
    const t = await lockDoc(Transfer, id, session, "Transfer");
    if (t.status !== "IN_TRANSIT") throw badRequest(`${t.code} is ${t.status.toLowerCase().replace("_", " ")}`);
    await assertSiteAccess(user, [s(t.toLocationId)]);

    const arriving = new Map();
    for (const l of dto.lines) arriving.set(l.variantId, (arriving.get(l.variantId) ?? 0) + l.quantity);
    for (const [variantId, n] of arriving) {
      const line = t.lines.find((x) => s(x.variantId) === variantId);
      if (!line) throw badRequest("That item is not part of this transfer");
      const left = line.quantity - line.received - line.lost;
      if (n > left) throw badRequest(`Only ${left} of that item still expected`);
    }
    const transitId = await systemLocationId("TRANSIT", session);
    await applyMoves(
      user.id,
      [...arriving].map(([variantId, quantity]) => ({
        type: "TRANSFER_IN",
        variantId,
        quantity,
        fromLocationId: transitId,
        toLocationId: s(t.toLocationId),
        reference: t.code,
      })),
      session
    );
    const lines = t.lines.map((l) => ({ ...l, received: l.received + (arriving.get(s(l.variantId)) ?? 0) }));
    const done = lines.every((l) => l.received + l.lost >= l.quantity);
    await Transfer.updateOne(
      { _id: id },
      { $set: { lines, receivedById: user.id, receivedAt: new Date(), ...(done && { status: "RECEIVED" }) } },
      { session }
    );
    await audit(
      {
        userId: user.id,
        action: "TRANSFER_RECEIVED",
        entity: "StockTransfer",
        entityId: id,
        data: { code: t.code, units: sum([...arriving.values()], (n) => n), complete: done },
      },
      session
    );
  });
  return getTransfer(id);
}

/** Manager: what never arrived is written off (ADJUSTMENT out of In Transit) and the transfer is closed. */
export async function closeMissing(user, id, reason) {
  await withTransaction(async (session) => {
    const t = await lockDoc(Transfer, id, session, "Transfer");
    if (t.status !== "IN_TRANSIT") throw badRequest(`${t.code} is already closed`);
    const transitId = await systemLocationId("TRANSIT", session);
    const missing = t.lines.map((l) => ({ l, n: l.quantity - l.received - l.lost })).filter((x) => x.n > 0);
    await applyMoves(
      user.id,
      missing.map(({ l, n }) => ({
        type: "ADJUSTMENT",
        variantId: s(l.variantId),
        quantity: n,
        fromLocationId: transitId,
        reason: "Lost in transfer",
        note: reason,
        reference: t.code,
      })),
      session
    );
    const lines = t.lines.map((l) => ({ ...l, lost: l.quantity - l.received }));
    await Transfer.updateOne({ _id: id }, { $set: { lines, status: "RECEIVED", closedReason: reason.trim() } }, { session });
    await audit(
      {
        userId: user.id,
        action: "TRANSFER_CLOSED_MISSING",
        entity: "StockTransfer",
        entityId: id,
        data: { code: t.code, missing: sum(missing, (x) => x.n), reason },
      },
      session
    );
  });
  return getTransfer(id);
}

/** Before anything was received: the stock goes back to where it came from. */
export async function cancelTransfer(user, id, reason) {
  await withTransaction(async (session) => {
    const t = await lockDoc(Transfer, id, session, "Transfer");
    if (t.status !== "IN_TRANSIT") throw badRequest(`${t.code} is already closed`);
    if (t.lines.some((l) => l.received > 0)) throw badRequest("Part of it was already received — close it instead");
    if (!MANAGERS.includes(user.role) && s(t.sentById) !== user.id) {
      throw forbidden("Only the sender or a manager can cancel a transfer");
    }
    const transitId = await systemLocationId("TRANSIT", session);
    await applyMoves(
      user.id,
      t.lines.map((l) => ({
        type: "TRANSFER_IN",
        variantId: s(l.variantId),
        quantity: l.quantity,
        fromLocationId: transitId,
        toLocationId: s(t.fromLocationId),
        reference: t.code,
        reason: "Transfer cancelled",
      })),
      session
    );
    await Transfer.updateOne({ _id: id }, { $set: { status: "CANCELLED", closedReason: reason.trim() } }, { session });
    await audit({ userId: user.id, action: "TRANSFER_CANCELLED", entity: "StockTransfer", entityId: id, data: { code: t.code, reason } }, session);
  });
  return getTransfer(id);
}

export async function getTransfer(id) {
  const t = await Transfer.findById(id).lean();
  if (!t) throw notFound("Transfer not found");
  const [paths, variants, users] = await Promise.all([
    withPaths().then((all) => new Map(all.map((l) => [l.id, l]))),
    variantRefs(t.lines.map((l) => l.variantId)),
    userRefs([t.sentById, t.receivedById]),
  ]);
  return {
    id: s(t._id),
    number: t.number,
    code: t.code,
    status: t.status,
    note: t.note,
    closedReason: t.closedReason,
    sentAt: t.sentAt,
    receivedAt: t.receivedAt,
    updatedAt: t.updatedAt,
    fromLocationId: s(t.fromLocationId),
    toLocationId: s(t.toLocationId),
    sentById: s(t.sentById),
    receivedById: s(t.receivedById),
    sentBy: users.get(s(t.sentById)) ?? null,
    receivedBy: users.get(s(t.receivedById)) ?? null,
    from: pathInfo(paths.get(s(t.fromLocationId))),
    to: pathInfo(paths.get(s(t.toLocationId))),
    lines: t.lines.map((l) => ({
      id: s(l._id),
      variantId: s(l.variantId),
      quantity: l.quantity,
      received: l.received,
      lost: l.lost,
      variant: variants.get(s(l.variantId)) ?? null,
    })),
  };
}

export async function listTransfers(query) {
  const rows = await Transfer.find(query.status ? { status: query.status } : {})
    .sort({ sentAt: -1 })
    .limit(100)
    .lean();
  const [paths, users] = await Promise.all([
    withPaths().then((all) => new Map(all.map((l) => [l.id, l]))),
    userRefs(rows.map((t) => t.sentById)),
  ]);
  return rows.map((t) => ({
    id: s(t._id),
    code: t.code,
    status: t.status,
    note: t.note,
    sentAt: t.sentAt,
    receivedAt: t.receivedAt,
    sentBy: { name: users.get(s(t.sentById))?.name ?? "?" },
    from: pathInfo(paths.get(s(t.fromLocationId))),
    to: pathInfo(paths.get(s(t.toLocationId))),
    units: sum(t.lines, (l) => l.quantity),
    received: sum(t.lines, (l) => l.received),
    lost: sum(t.lines, (l) => l.lost),
  }));
}
