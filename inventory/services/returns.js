// inventory/services/returns.js — returns create a credit note against an invoice (the sale never changes).
import { lockKey, nextCounter, withTransaction } from "../lib/db.js";
import { badRequest, notFound } from "../lib/http.js";
import { m2, userRefs } from "../lib/refs.js";
import { escapeRegex } from "../lib/validate.js";
import { CreditNote, Sale } from "../models/Sale.js";
import { audit } from "./audit.js";
import { assertSiteAccess, systemLocationId, withPaths } from "./locations.js";
import { fromCents, toCents } from "./pricing.js";
import { applyMoves } from "./stock.js";

const s = (v) => (v == null ? v : String(v));

export const creditNumber = (n) => `CN-${String(n).padStart(6, "0")}`;

/**
 * Refund for returning `quantity` units of an invoice line: the share of what was actually
 * charged (after discount). The last units returned get exactly what's left, so rounding can
 * never refund more — or less — than the customer paid.
 * sold / alreadyReturned: { quantity, totalCents, taxCents }
 */
export function refundFor(sold, alreadyReturned, quantity) {
  const left = sold.quantity - alreadyReturned.quantity;
  if (!Number.isInteger(quantity) || quantity < 1) throw new Error("Return at least 1");
  if (quantity > left) throw new Error(left === 0 ? "Already fully returned" : `Only ${left} left to return`);
  if (quantity === left) {
    return { totalCents: sold.totalCents - alreadyReturned.totalCents, taxCents: sold.taxCents - alreadyReturned.taxCents };
  }
  return {
    totalCents: Math.round((sold.totalCents * quantity) / sold.quantity),
    taxCents: Math.round((sold.taxCents * quantity) / sold.quantity),
  };
}

/** How many of each box one kit unit used, from where the boxes were picked at sale time. */
export function boxesPerUnit(picks, lineQuantity) {
  const totals = new Map();
  for (const p of picks) totals.set(s(p.variantId), (totals.get(s(p.variantId)) ?? 0) + p.quantity);
  return new Map([...totals].map(([id, n]) => [id, n / lineQuantity]));
}

/** dto: { saleId, lines: [{ saleLineId, quantity, condition, locationId? }], refundMethod, refundReference?, reason? } */
export async function createReturn(user, dto) {
  const ids = dto.lines.map((l) => l.saleLineId);
  if (new Set(ids).size !== ids.length) throw badRequest("Each invoice line can only appear once");
  await assertSiteAccess(user, dto.lines.filter((l) => l.condition === "GOOD").map((l) => l.locationId));
  const damagedId = await systemLocationId("DAMAGED");

  const id = await withTransaction(async (session) => {
    // Lock the invoice so two returns against it can't both pass the "not more than sold" check.
    await lockKey(`sale:${dto.saleId}`, session);
    const sale = await Sale.findById(dto.saleId).session(session).lean();
    if (!sale) throw notFound("Invoice not found");
    const earlier = await CreditNote.find({ saleId: sale._id }).session(session).lean();

    const number = await nextCounter("credit_note", session);
    const code = creditNumber(number);
    const lines = [];
    const moves = [];
    let totalCents = 0;
    let taxCents = 0;

    for (const req of dto.lines) {
      const line = sale.lines.find((l) => s(l._id) === req.saleLineId);
      if (!line) throw badRequest("That item is not on this invoice");
      const toLocationId = req.condition === "DAMAGED" ? damagedId : req.locationId;
      if (!toLocationId) throw badRequest(`${line.description}: choose where it goes back to`);

      const already = { quantity: 0, totalCents: 0, taxCents: 0 };
      for (const n of earlier) {
        for (const r of n.lines) {
          if (s(r.saleLineId) !== s(line._id)) continue;
          already.quantity += r.quantity;
          already.totalCents += toCents(r.total);
          already.taxCents += toCents(r.taxAmount);
        }
      }
      let refund;
      try {
        refund = refundFor({ quantity: line.quantity, totalCents: toCents(line.total), taxCents: toCents(line.taxAmount) }, already, req.quantity);
      } catch (e) {
        throw badRequest(`${line.description}: ${e.message}`);
      }
      totalCents += refund.totalCents;
      taxCents += refund.taxCents;
      lines.push({
        saleLineId: line._id,
        quantity: req.quantity,
        condition: req.condition,
        locationId: toLocationId,
        total: refund.totalCents / 100,
        taxAmount: refund.taxCents / 100,
      });

      // A kit comes back as all of its boxes, in the numbers sold.
      for (const [variantId, perUnit] of boxesPerUnit(line.picks, line.quantity)) {
        moves.push({
          type: "SALE_RETURN",
          variantId,
          quantity: perUnit * req.quantity,
          toLocationId: String(toLocationId),
          reason: req.condition === "DAMAGED" ? "Returned damaged" : "Customer return",
          note: dto.reason,
          reference: code,
        });
      }
    }

    const [created] = await CreditNote.create(
      [
        {
          number,
          creditNumber: code,
          saleId: sale._id,
          cashierId: user.id,
          reason: dto.reason?.trim() || null,
          refundMethod: dto.refundMethod,
          refundReference: dto.refundReference?.trim() || null,
          netTotal: (totalCents - taxCents) / 100,
          taxTotal: taxCents / 100,
          total: totalCents / 100,
          lines,
        },
      ],
      { session }
    );
    await applyMoves(user.id, moves, session);
    await audit(
      {
        userId: user.id,
        action: "RETURN_COMPLETED",
        entity: "CreditNote",
        entityId: created._id,
        data: { creditNumber: code, invoiceNumber: sale.invoiceNumber, total: fromCents(totalCents) },
      },
      session
    );
    return created._id;
  });
  return getReturn(id);
}

export async function getReturn(id) {
  const note = await CreditNote.findById(id).lean();
  if (!note) throw notFound("Credit note not found");
  const [sale, users, all] = await Promise.all([Sale.findById(note.saleId).lean(), userRefs([note.cashierId]), withPaths()]);
  const paths = new Map(all.map((l) => [l.id, l.path]));
  const saleLine = (lineId) => sale?.lines.find((l) => s(l._id) === s(lineId));
  return {
    id: s(note._id),
    number: note.number,
    creditNumber: note.creditNumber,
    saleId: s(note.saleId),
    reason: note.reason,
    refundMethod: note.refundMethod,
    refundReference: note.refundReference,
    netTotal: m2(note.netTotal),
    taxTotal: m2(note.taxTotal),
    total: m2(note.total),
    createdAt: note.createdAt,
    sale: sale
      ? {
          id: s(sale._id),
          invoiceNumber: sale.invoiceNumber,
          customerName: sale.customerName,
          customerPhone: sale.customerPhone,
          currency: sale.currency,
          createdAt: sale.createdAt,
        }
      : null,
    cashier: users.get(s(note.cashierId)) ?? { id: s(note.cashierId), name: "?" },
    lines: note.lines.map((l) => {
      const sl = saleLine(l.saleLineId);
      return {
        id: s(l._id),
        saleLineId: s(l.saleLineId),
        quantity: l.quantity,
        condition: l.condition,
        locationId: s(l.locationId),
        locationPath: paths.get(s(l.locationId)) ?? "?",
        taxAmount: m2(l.taxAmount),
        total: m2(l.total),
        saleLine: sl
          ? { description: sl.description, code: sl.code, quantity: sl.quantity, unitPrice: m2(sl.unitPrice), taxRate: m2(sl.taxRate) }
          : null,
      };
    }),
  };
}

export async function listReturns(query) {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 25;
  const q = query.q?.trim();
  const filter = {};
  if (q) {
    const rx = new RegExp(escapeRegex(q), "i");
    const saleIds = await Sale.find({ $or: [{ invoiceNumber: rx }, { customerName: rx }] }).distinct("_id");
    filter.$or = [{ creditNumber: rx }, { saleId: { $in: saleIds } }];
  }
  const [rows, total] = await Promise.all([
    CreditNote.find(filter).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
    CreditNote.countDocuments(filter),
  ]);
  const [sales, users] = await Promise.all([
    Sale.find({ _id: { $in: rows.map((r) => r.saleId) } }).select("invoiceNumber customerName").lean(),
    userRefs(rows.map((r) => r.cashierId)),
  ]);
  const saleById = new Map(sales.map((x) => [s(x._id), x]));
  const items = rows.map((r) => {
    const sale = saleById.get(s(r.saleId));
    return {
      id: s(r._id),
      creditNumber: r.creditNumber,
      total: m2(r.total),
      createdAt: r.createdAt,
      sale: { id: s(r.saleId), invoiceNumber: sale?.invoiceNumber ?? "?", customerName: sale?.customerName ?? null },
      cashier: users.get(s(r.cashierId)) ?? { id: s(r.cashierId), name: "?" },
    };
  });
  return { items, total, page, pageSize };
}
