// inventory/services/sales.js — POS sales. Prices and VAT are worked out here (never trusted from the
// till), the stock taken must match what is sold, and the invoice number comes from a counter inside
// the sale's transaction, so numbers have no gaps.
import { verifyApprover } from "../auth/approver.js";
import { APPROVER_ROLES } from "../auth/roles.js";
import { dayRange } from "../lib/dates.js";
import { nextCounter, withTransaction } from "../lib/db.js";
import { badRequest, forbidden, notFound } from "../lib/http.js";
import { m2, userRefs } from "../lib/refs.js";
import { escapeRegex } from "../lib/validate.js";
import { TaxRate, Variant } from "../models/Catalog.js";
import { CreditNote, Sale } from "../models/Sale.js";
import { audit } from "./audit.js";
import { assertSiteAccess, withPaths } from "./locations.js";
import { withDescendants } from "./locationTree.js";
import { fromCents, pickProblem, priceLine, settle, sumLines, toCents } from "./pricing.js";
import { getSettings } from "./settings.js";
import { applyMoves } from "./stock.js";

const s = (v) => (v == null ? v : String(v));

export const invoiceNumber = (n) => `INV-${String(n).padStart(6, "0")}`;

const moneyOf = (p) => ({
  gross: fromCents(p.grossCents),
  discount: fromCents(p.discountCents),
  net: fromCents(p.netCents),
  tax: fromCents(p.taxCents),
  total: fromCents(p.totalCents),
});

/** Prices a cart exactly as a sale would be charged (the POS shows these numbers). */
export async function previewSale(user, lines) {
  const settings = await getSettings();
  const priced = await priceLines(lines, settings.pricesIncludeTax);
  return {
    lines: priced.map((p) => ({ variantId: s(p.variant._id), ...moneyOf(p.priced), unitPrice: fromCents(p.unitCents), taxRate: p.taxRate })),
    totals: moneyOf(sumLines(priced.map((p) => p.priced))),
    maxDiscountPercent: settings.maxDiscountPercent,
    needsApproval: needsApproval(user, lines, settings.maxDiscountPercent),
  };
}

export async function createSale(user, dto) {
  const settings = await getSettings();
  const priced = await priceLines(dto.lines, settings.pricesIncludeTax);

  // Stock taken must match what is sold (every box of a kit, exact quantities).
  const boxNames = await componentNames(priced);
  for (const [i, line] of dto.lines.entries()) {
    const p = priced[i];
    const problem = pickProblem(
      {
        name: p.description,
        kind: p.variant.kind === "KIT" ? "KIT" : "STANDARD",
        variantId: s(p.variant._id),
        quantity: line.quantity,
        boxes: (p.variant.components ?? []).map((c) => ({
          variantId: s(c.componentVariantId),
          name: (boxNames.get(s(c.componentVariantId)) ?? "Box").split(" – ")[0],
          perKit: c.quantity,
        })),
      },
      line.picks
    );
    if (problem) throw badRequest(problem);
  }

  const pickLocations = dto.lines.flatMap((l) => l.picks.map((p) => p.locationId));
  if (dto.siteId) await assertPicksInSite(dto.siteId, pickLocations);
  await assertSiteAccess(user, [dto.siteId, ...pickLocations]);

  let approvedById = null;
  if (needsApproval(user, dto.lines, settings.maxDiscountPercent)) {
    if (!dto.approval) throw forbidden(`A discount above ${settings.maxDiscountPercent}% needs a manager's approval`);
    approvedById = await verifyApprover(dto.approval);
  }

  const totals = sumLines(priced.map((p) => p.priced));
  let settlement;
  try {
    settlement = settle(
      totals.totalCents,
      dto.payments.map((p) => ({ method: p.method, cents: toCents(p.amount) }))
    );
  } catch (e) {
    throw badRequest(e.message);
  }
  const euros = (cents) => cents / 100;

  const id = await withTransaction(async (session) => {
    // The counter rolls back with a failed sale: no gaps.
    const number = await nextCounter("invoice", session);
    const invoice = invoiceNumber(number);
    const [created] = await Sale.create(
      [
        {
          number,
          invoiceNumber: invoice,
          siteId: dto.siteId ?? null,
          cashierId: user.id,
          approvedById,
          customerName: dto.customerName?.trim() || null,
          customerPhone: dto.customerPhone?.trim() || null,
          note: dto.note?.trim() || null,
          currency: settings.currency,
          pricesIncludeTax: settings.pricesIncludeTax,
          grossTotal: euros(totals.grossCents),
          discountTotal: euros(totals.discountCents),
          netTotal: euros(totals.netCents),
          taxTotal: euros(totals.taxCents),
          total: euros(totals.totalCents),
          paidTotal: euros(settlement.paidCents),
          changeGiven: euros(settlement.changeCents),
          lines: dto.lines.map((line, i) => {
            const p = priced[i];
            return {
              lineNo: i + 1,
              variantId: p.variant._id,
              description: p.description,
              code: p.variant.code,
              quantity: line.quantity,
              unitPrice: euros(p.unitCents),
              discountPercent: line.discountPercent ?? 0,
              discountAmount: euros(p.priced.discountCents),
              taxRateName: p.taxRateName,
              taxRate: p.taxRate,
              taxAmount: euros(p.priced.taxCents),
              total: euros(p.priced.totalCents),
              picks: line.picks.map((pk) => ({ variantId: pk.variantId, locationId: pk.locationId, quantity: pk.quantity })),
            };
          }),
          payments: dto.payments.map((p) => ({ method: p.method, amount: p.amount, reference: p.reference?.trim() || null })),
        },
      ],
      { session }
    );

    await applyMoves(
      user.id,
      dto.lines.flatMap((l) =>
        l.picks.map((pk) => ({ type: "SALE", variantId: pk.variantId, quantity: pk.quantity, fromLocationId: pk.locationId, reference: invoice }))
      ),
      session
    );
    await audit(
      {
        userId: user.id,
        action: "SALE_COMPLETED",
        entity: "Sale",
        entityId: created._id,
        data: { invoiceNumber: invoice, total: fromCents(totals.totalCents), approvedById },
      },
      session
    );
    return created._id;
  });
  return getSale(id);
}

/** The full invoice, as the frontend's Sale type. */
export async function getSale(id) {
  const sale = await Sale.findById(id).lean();
  if (!sale) throw notFound("Sale not found");
  const [notes, users, site] = await Promise.all([
    CreditNote.find({ saleId: sale._id }).sort({ createdAt: 1 }).lean(),
    userRefs([sale.cashierId, sale.approvedById]),
    sale.siteId ? withPaths().then((all) => all.find((l) => l.id === s(sale.siteId))) : null,
  ]);
  const returnedBy = new Map();
  for (const n of notes) {
    for (const l of n.lines) {
      const list = returnedBy.get(s(l.saleLineId)) ?? [];
      list.push({ quantity: l.quantity, total: m2(l.total), taxAmount: m2(l.taxAmount) });
      returnedBy.set(s(l.saleLineId), list);
    }
  }
  return {
    id: s(sale._id),
    number: sale.number,
    invoiceNumber: sale.invoiceNumber,
    siteId: s(sale.siteId),
    site: site ? { id: site.id, name: site.name } : null,
    cashierId: s(sale.cashierId),
    cashier: users.get(s(sale.cashierId)) ?? { id: s(sale.cashierId), name: "?" },
    approvedById: s(sale.approvedById),
    approvedBy: users.get(s(sale.approvedById)) ?? null,
    customerName: sale.customerName,
    customerPhone: sale.customerPhone,
    note: sale.note,
    currency: sale.currency,
    pricesIncludeTax: sale.pricesIncludeTax,
    grossTotal: m2(sale.grossTotal),
    discountTotal: m2(sale.discountTotal),
    netTotal: m2(sale.netTotal),
    taxTotal: m2(sale.taxTotal),
    total: m2(sale.total),
    paidTotal: m2(sale.paidTotal),
    changeGiven: m2(sale.changeGiven),
    createdAt: sale.createdAt,
    lines: sale.lines.map((l) => ({
      id: s(l._id),
      lineNo: l.lineNo,
      variantId: s(l.variantId),
      description: l.description,
      code: l.code,
      quantity: l.quantity,
      unitPrice: m2(l.unitPrice),
      discountPercent: m2(l.discountPercent),
      discountAmount: m2(l.discountAmount),
      taxRateName: l.taxRateName,
      taxRate: m2(l.taxRate),
      taxAmount: m2(l.taxAmount),
      total: m2(l.total),
      picks: l.picks.map((p) => ({ variantId: s(p.variantId), locationId: s(p.locationId), quantity: p.quantity })),
      returnLines: returnedBy.get(s(l._id)) ?? [],
    })),
    payments: sale.payments.map((p) => ({ id: s(p._id), method: p.method, amount: m2(p.amount), reference: p.reference, createdAt: p.createdAt })),
    creditNotes: notes.map((n) => ({ id: s(n._id), creditNumber: n.creditNumber, total: m2(n.total), createdAt: n.createdAt })),
  };
}

/** Totals for a period (the dashboard asks for "today" in the shop's time zone). */
export async function salesSummary(from, to) {
  const match = { createdAt: { $gte: from, $lt: to } };
  const agg = (Model) =>
    Model.aggregate([{ $match: match }, { $group: { _id: null, count: { $sum: 1 }, total: { $sum: "$total" } } }]).then(
      (r) => r[0] ?? { count: 0, total: 0 }
    );
  const [sales, returns] = await Promise.all([agg(Sale), agg(CreditNote)]);
  return { salesCount: sales.count, salesTotal: m2(sales.total), returnsCount: returns.count, returnsTotal: m2(returns.total) };
}

/** For scanning the barcode on a receipt, or typing the invoice number. */
export async function findSaleByNumber(invoice) {
  const sale = await Sale.findOne({ invoiceNumber: invoice.trim().toUpperCase() }).select("_id").lean();
  if (!sale) throw notFound(`No invoice ${invoice.trim()}`);
  return getSale(sale._id);
}

export async function listSales(query) {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 25;
  const q = query.q?.trim();
  const filter = {};
  if (q) {
    const rx = new RegExp(escapeRegex(q), "i");
    filter.$or = [{ invoiceNumber: rx }, { customerName: rx }, { customerPhone: rx }];
  }
  const range = dayRange(query.from, query.to);
  if (range) filter.createdAt = range;

  const [rows, total] = await Promise.all([
    Sale.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .select("invoiceNumber customerName customerPhone total createdAt cashierId lines._id")
      .lean(),
    Sale.countDocuments(filter),
  ]);
  const users = await userRefs(rows.map((r) => r.cashierId));
  const items = rows.map((r) => ({
    id: s(r._id),
    invoiceNumber: r.invoiceNumber,
    customerName: r.customerName,
    customerPhone: r.customerPhone,
    total: m2(r.total),
    createdAt: r.createdAt,
    cashier: users.get(s(r.cashierId)) ?? { id: s(r.cashierId), name: "?" },
    _count: { lines: r.lines.length },
  }));
  return { items, total, page, pageSize };
}

// ---------------------------------------------------------------- helpers

async function priceLines(lines, pricesIncludeTax) {
  const variants = await Variant.find({ _id: { $in: [...new Set(lines.map((l) => l.variantId))] } })
    .populate("productId", "name status taxRateId")
    .lean();
  const byId = new Map(variants.map((v) => [s(v._id), v]));
  const taxIds = [...new Set(variants.map((v) => s(v.productId?.taxRateId)).filter(Boolean))];
  const taxes = new Map((await TaxRate.find({ _id: { $in: taxIds } }).lean()).map((t) => [s(t._id), t]));

  return lines.map((line) => {
    const variant = byId.get(line.variantId);
    if (!variant) throw notFound("One of the items no longer exists");
    const product = variant.productId ?? {};
    const description = variant.kind === "STANDARD" && variant.name !== "Default" ? `${product.name} – ${variant.name}` : product.name;
    if (variant.kind === "COMPONENT") throw badRequest(`${description}: a single box can't be sold — sell the whole kit`);
    if (!variant.active || product.status === "INACTIVE") throw badRequest(`${description} is not for sale (inactive)`);
    if (variant.price === null || variant.price === undefined) throw badRequest(`${description} has no price`);

    const tax = taxes.get(s(product.taxRateId));
    const unitCents = toCents(variant.price);
    const taxRate = tax ? Number(tax.rate) : 0;
    const priced = priceLine({ unitCents, quantity: line.quantity, discountPercent: line.discountPercent ?? 0, taxRate }, pricesIncludeTax);
    return { variant, description, unitCents, taxRate, taxRateName: tax?.name ?? null, priced };
  });
}

async function componentNames(priced) {
  const ids = priced.flatMap((p) => (p.variant.components ?? []).map((c) => c.componentVariantId));
  if (!ids.length) return new Map();
  const rows = await Variant.find({ _id: { $in: ids } }).select("name").lean();
  return new Map(rows.map((r) => [s(r._id), r.name]));
}

function needsApproval(user, lines, maxPercent) {
  return !APPROVER_ROLES.includes(user.role) && lines.some((l) => (l.discountPercent ?? 0) > maxPercent);
}

/** The POS only sells from spaces inside its own site. */
async function assertPicksInSite(siteId, locationIds) {
  const all = await withPaths();
  const site = all.find((l) => l.id === siteId);
  if (!site || site.type !== "SITE") throw badRequest("Unknown shop/site");
  const inside = new Set(withDescendants(all, [siteId]).map((l) => l.id));
  const outside = locationIds.find((id) => !inside.has(id));
  if (outside) {
    const path = all.find((l) => l.id === outside)?.path ?? "another site";
    throw badRequest(`${path} is not in ${site.name} — the POS only sells stock from its own site`);
  }
}
