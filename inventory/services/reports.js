// inventory/services/reports.js — every report (spec §11) as columns + rows, shown on screen
// and exported to Excel. Each report loads the matching documents and groups them in code:
// the shop's data is small enough, and it keeps the rules readable.
import ExcelJS from "exceljs";
import { dayRange, TIMEZONE } from "../lib/dates.js";
import { notFound } from "../lib/http.js";
import { Category, Product, Variant } from "../models/Catalog.js";
import AuditLog from "../models/AuditLog.js";
import { Order } from "../models/Order.js";
import { CreditNote, Sale } from "../models/Sale.js";
import { StockLevel, StockMovement } from "../models/Stock.js";
import { Stocktake, StocktakeLine, Transfer } from "../models/Transfer.js";
import User from "../models/User.js";
import { PAYMENT_LABELS } from "./documents.js";
import { withPaths } from "./locations.js";
import { SYSTEM_TYPES, withDescendants } from "./locationTree.js";
import { kitAvailability, MOVEMENT_LABELS } from "./movementRules.js";
import { lowStock } from "./stockQuery.js";

export const MAX_ROWS = 10_000;
const COST_ROLES = ["ADMIN", "MANAGER"];
const s = (v) => (v == null ? v : String(v));
const iso = (d) => (d ? new Date(d).toISOString() : null);
const num = (v) => (v === null || v === undefined ? null : Number(v));
const round2 = (n) => Math.round(n * 100) / 100;
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

const ORDER_LABELS = {
  NEW: "New",
  ALLOCATED: "Stock reserved",
  PICKING: "Picking",
  LOADED: "Loaded",
  OUT_FOR_DELIVERY: "Out for delivery",
  DELIVERED: "Delivered",
  FAILED: "Delivery failed",
  RETURNED: "Returned",
  CANCELLED: "Cancelled",
};

/** Every report. The order here is the order on the Reports page. */
export const REPORTS = [
  { type: "sales", group: "Sales", title: "Sales (invoices)", description: "Every invoice with VAT and payment.", filters: ["date", "user", "location", "product", "category"], userLabel: "Cashier" },
  { type: "sales-by-day", group: "Sales", title: "POS sales by day", description: "Sales, returns and net takings per day.", filters: ["date", "user", "location"], userLabel: "Cashier" },
  { type: "channel-summary", group: "Sales", title: "Daily summary by channel", description: "Per day: shop sales, website and manual orders delivered, and returns.", filters: ["date"] },
  { type: "sales-by-cashier", group: "Sales", title: "Sales by cashier", description: "What each salesperson sold.", filters: ["date", "location"] },
  { type: "sales-by-product", group: "Sales", title: "Sales by product", description: "Quantities and value sold per item.", filters: ["date", "user", "location", "product", "category"], userLabel: "Cashier" },
  { type: "returns", group: "Sales", title: "Returns", description: "Credit notes: what came back, condition and refund.", filters: ["date", "user", "product", "category"], userLabel: "Processed by" },
  { type: "inventory", group: "Stock", title: "Inventory", description: "Stock of every item: in store, reserved, in transit, damaged (and value).", filters: ["location", "product", "category"] },
  { type: "stock-by-location", group: "Stock", title: "Stock by location", description: "What is on every shelf and space.", filters: ["location", "product", "category"] },
  { type: "low-stock", group: "Stock", title: "Low stock", description: "Items below their minimum stock.", filters: ["category"] },
  { type: "movements", group: "Stock", title: "Stock movements", description: "Every stock change: who, what, when, where, why.", filters: ["date", "user", "location", "product", "category"], userLabel: "Done by" },
  { type: "damaged", group: "Stock", title: "Damaged stock", description: "What is in the Damaged location now.", filters: ["product", "category"] },
  { type: "stocktake-variance", group: "Stock", title: "Stocktake differences", description: "Corrections made by approved stocktakes.", filters: ["date", "location", "product", "category"] },
  { type: "incomplete-kits", group: "Stock", title: "Incomplete kits", description: "Spare boxes that do not make a complete kit.", filters: ["product", "category"] },
  { type: "orders", group: "Orders & deliveries", title: "Orders", description: "Orders created, with status and driver.", filters: ["date", "user", "product"], userLabel: "Driver" },
  { type: "in-transit", group: "Orders & deliveries", title: "On the vans / in transit", description: "What is on each driver’s van right now, and transfers on the way.", filters: ["user"], userLabel: "Driver" },
  { type: "deliveries", group: "Orders & deliveries", title: "Deliveries", description: "Delivered and failed orders, cash collected vs expected.", filters: ["date", "user"], userLabel: "Driver" },
  { type: "picking-errors", group: "Control", title: "Picking errors", description: "Rejected pick scans: wrong item, box or place, or too many.", filters: ["date", "user"], userLabel: "Picker" },
  { type: "overrides", group: "Control", title: "Overrides & approvals", description: "Every manager approval: discounts, pick location, missing boxes, partial deliveries.", filters: ["date", "user"], userLabel: "Done by" },
];

const col = (key, label, type = "text", total = false) => ({ key, label, type, ...(total && { total }) });

// ---------------------------------------------------------------- dates

const wallParts = new Intl.DateTimeFormat("en-US", {
  timeZone: TIMEZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** The same instant written as Malta wall-clock time, stored as if it were UTC (for Excel and day keys). */
export function maltaWallClock(date) {
  const p = Object.fromEntries(wallParts.formatToParts(date).map((x) => [x.type, x.value]));
  return new Date(Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second));
}
const maltaDay = (date) => maltaWallClock(new Date(date)).toISOString().slice(0, 10);

// ---------------------------------------------------------------- run

/** f: { from?, to?, productId?, locationId?, userId?, categoryId? } */
export async function runReport(type, f, user) {
  const info = REPORTS.find((r) => r.type === type);
  if (!info) throw notFound("Unknown report");
  const all = await withPaths();
  const ctx = { f, user, all, paths: new Map(all.map((l) => [l.id, l])), created: dayRange(f.from, f.to) };
  const { columns, rows } = await BUILDERS[type](ctx);
  const truncated = rows.length > MAX_ROWS;
  const shown = truncated ? rows.slice(0, MAX_ROWS) : rows;
  const totalCols = columns.filter((c) => c.total);
  const totals = totalCols.length
    ? Object.fromEntries(totalCols.map((c) => [c.key, round2(shown.reduce((t, r) => t + (Number(r[c.key]) || 0), 0))]))
    : null;
  return { type, title: info.title, columns, rows: shown, totals, truncated, generatedAt: new Date().toISOString() };
}

/** Adds `field: range` to a filter when a date range was chosen. */
const when = (field, range) => (range ? { [field]: range } : {});

/** Ids of the chosen location and everything inside it. */
const scopeIds = (c) => withDescendants(c.all, [c.f.locationId]).map((l) => l.id);

/**
 * Variant info for names and product/category filters:
 * id → { id, kind, code, sku, name, costPrice, active, components, productId, product, categoryId, category, status }
 */
async function catalog() {
  const [variants, products, categories] = await Promise.all([
    Variant.find().select("kind code sku name costPrice active components productId").lean(),
    Product.find().select("name categoryId status minStock").lean(),
    Category.find().select("name").lean(),
  ]);
  const cats = new Map(categories.map((x) => [s(x._id), x.name]));
  const prods = new Map(products.map((p) => [s(p._id), p]));
  return new Map(
    variants.map((v) => {
      const p = prods.get(s(v.productId)) ?? {};
      return [
        s(v._id),
        {
          ...v,
          id: s(v._id),
          productId: s(v.productId),
          product: p.name ?? "?",
          categoryId: s(p.categoryId) ?? null,
          category: cats.get(s(p.categoryId)) ?? null,
          status: p.status,
        },
      ];
    })
  );
}

const nameOf = (v) =>
  !v ? "?" : v.kind === "STANDARD" && v.name !== "Default" ? `${v.product} – ${v.name}` : v.kind === "COMPONENT" ? `${v.product}, ${v.name.split(" – ")[0]}` : v.product;

/** True when the variant passes the product / category filters. */
const matches = (c, v) => !!v && (!c.f.productId || v.productId === c.f.productId) && (!c.f.categoryId || v.categoryId === c.f.categoryId);
const filtersItems = (c) => !!(c.f.productId || c.f.categoryId);

async function namesOf(ids) {
  const users = await User.find({ _id: { $in: [...new Set(ids.filter(Boolean).map(String))] } }).select("name").lean();
  return new Map(users.map((u) => [s(u._id), u.name]));
}

// ---------------------------------------------------------------- sales

async function loadSales(c, { ignoreItems = false } = {}) {
  const filter = { ...when("createdAt", c.created) };
  if (c.f.userId) filter.cashierId = c.f.userId;
  if (c.f.locationId) filter.siteId = { $in: scopeIds(c) };
  const sales = await Sale.find(filter).sort({ createdAt: 1 }).lean();
  if (ignoreItems || !filtersItems(c)) return { sales, cat: null };
  const cat = await catalog();
  return { sales: sales.filter((x) => x.lines.some((l) => matches(c, cat.get(s(l.variantId))))), cat };
}

async function sales(c) {
  const { sales: rows } = await loadSales(c);
  const names = await namesOf(rows.flatMap((x) => [x.cashierId, x.approvedById]));
  const sites = c.paths;
  return {
    columns: [
      col("date", "Date", "datetime"),
      col("invoice", "Invoice"),
      col("site", "Shop"),
      col("cashier", "Cashier"),
      col("customer", "Customer"),
      col("items", "Items", "number", true),
      col("discount", "Discount", "money", true),
      col("net", "Excl. VAT", "money", true),
      col("vat", "VAT", "money", true),
      col("total", "Total", "money", true),
      col("payment", "Paid by"),
      col("approvedBy", "Discount approved by"),
    ],
    rows: rows.map((x) => ({
      date: iso(x.createdAt),
      invoice: x.invoiceNumber,
      site: x.siteId ? (sites.get(s(x.siteId))?.name ?? null) : null,
      cashier: names.get(s(x.cashierId)) ?? null,
      customer: [x.customerName, x.customerPhone].filter(Boolean).join(", ") || null,
      items: x.lines.reduce((n, l) => n + l.quantity, 0),
      discount: num(x.discountTotal),
      net: num(x.netTotal),
      vat: num(x.taxTotal),
      total: num(x.total),
      payment: x.payments.map((p) => `${PAYMENT_LABELS[p.method]} ${Number(p.amount).toFixed(2)}`).join(" + "),
      approvedBy: x.approvedById ? (names.get(s(x.approvedById)) ?? null) : null,
    })),
  };
}

async function salesByDay(c) {
  const { sales: rows } = await loadSales(c);
  const noteFilter = { ...when("createdAt", c.created) };
  if (c.f.userId) noteFilter.cashierId = c.f.userId;
  if (c.f.locationId) noteFilter.saleId = { $in: await Sale.find({ siteId: { $in: scopeIds(c) } }).distinct("_id") };
  const notes = await CreditNote.find(noteFilter).select("createdAt total").lean();

  const days = new Map();
  const day = (d) => {
    const key = maltaDay(d);
    const row = days.get(key) ?? { sales: 0, total: 0, vat: 0, returns: 0, refunded: 0 };
    days.set(key, row);
    return row;
  };
  for (const x of rows) {
    const r = day(x.createdAt);
    r.sales += 1;
    r.total += Number(x.total);
    r.vat += Number(x.taxTotal);
  }
  for (const n of notes) {
    const r = day(n.createdAt);
    r.returns += 1;
    r.refunded += Number(n.total);
  }
  return {
    columns: [
      col("day", "Day", "date"),
      col("sales", "Sales", "number", true),
      col("total", "Takings", "money", true),
      col("vat", "VAT", "money", true),
      col("returns", "Returns", "number", true),
      col("refunded", "Refunded", "money", true),
      col("net", "Net", "money", true),
    ],
    rows: [...days.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([d, r]) => ({ day: d, sales: r.sales, total: round2(r.total), vat: round2(r.vat), returns: r.returns, refunded: round2(r.refunded), net: round2(r.total - r.refunded) })),
  };
}

/** One row per day across all channels: shop (POS), website orders, manual orders, returns. */
async function channelSummary(c) {
  const [saleRows, notes, orders] = await Promise.all([
    Sale.find(when("createdAt", c.created)).select("createdAt total").lean(),
    CreditNote.find(when("createdAt", c.created)).select("createdAt total").lean(),
    Order.find({ status: "DELIVERED", ...when("deliveredAt", c.created) }).select("deliveredAt source codAmount paymentStatus lines").lean(),
  ]);
  const days = new Map();
  const day = (d) => {
    const k = maltaDay(d);
    const row = days.get(k) ?? { pos: 0, posTotal: 0, web: 0, webValue: 0, manual: 0, manualValue: 0, returns: 0, refunded: 0 };
    days.set(k, row);
    return row;
  };
  for (const x of saleRows) {
    const r = day(x.createdAt);
    r.pos += 1;
    r.posTotal += Number(x.total);
  }
  for (const n of notes) {
    const r = day(n.createdAt);
    r.returns += 1;
    r.refunded += Number(n.total);
  }
  for (const o of orders) {
    const r = day(o.deliveredAt);
    // Value: website prices if sent, otherwise the cash-on-delivery amount.
    const priced = o.lines.every((l) => l.unitPrice !== null) ? o.lines.reduce((t, l) => t + Number(l.unitPrice) * l.quantity, 0) : Number(o.codAmount ?? 0);
    if (o.source === "WEBSITE") {
      r.web += 1;
      r.webValue += priced;
    } else {
      r.manual += 1;
      r.manualValue += priced;
    }
  }
  return {
    columns: [
      col("day", "Day", "date"),
      col("pos", "Shop sales", "number", true),
      col("posTotal", "Shop takings", "money", true),
      col("web", "Website orders delivered", "number", true),
      col("webValue", "Website value", "money", true),
      col("manual", "Other orders delivered", "number", true),
      col("manualValue", "Other orders value", "money", true),
      col("returns", "Returns", "number", true),
      col("refunded", "Refunded", "money", true),
    ],
    rows: [...days.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([d, r]) => ({
        day: d,
        pos: r.pos,
        posTotal: round2(r.posTotal),
        web: r.web,
        webValue: round2(r.webValue),
        manual: r.manual,
        manualValue: round2(r.manualValue),
        returns: r.returns,
        refunded: round2(r.refunded),
      })),
  };
}

async function salesByCashier(c) {
  const { sales: rows } = await loadSales({ ...c, f: { ...c.f, userId: undefined } }, { ignoreItems: true });
  const names = await namesOf(rows.map((x) => x.cashierId));
  const by = new Map();
  for (const x of rows) {
    const id = s(x.cashierId);
    const r = by.get(id) ?? { name: names.get(id) ?? "?", sales: 0, items: 0, discount: 0, total: 0 };
    r.sales += 1;
    r.items += x.lines.reduce((n, l) => n + l.quantity, 0);
    r.discount += Number(x.discountTotal);
    r.total += Number(x.total);
    by.set(id, r);
  }
  return {
    columns: [
      col("cashier", "Cashier"),
      col("sales", "Sales", "number", true),
      col("items", "Items", "number", true),
      col("discount", "Discounts given", "money", true),
      col("total", "Total sold", "money", true),
      col("average", "Average sale", "money"),
    ],
    rows: [...by.values()]
      .sort((a, b) => b.total - a.total)
      .map((r) => ({ cashier: r.name, sales: r.sales, items: r.items, discount: round2(r.discount), total: round2(r.total), average: round2(r.total / r.sales) })),
  };
}

/** saleLineId → [{ quantity, total }] for the given sales. */
async function returnsBySaleLine(saleIds) {
  const notes = await CreditNote.find({ saleId: { $in: saleIds } }).select("lines").lean();
  const map = new Map();
  for (const n of notes) {
    for (const l of n.lines) {
      const list = map.get(s(l.saleLineId)) ?? [];
      list.push({ quantity: l.quantity, total: Number(l.total) });
      map.set(s(l.saleLineId), list);
    }
  }
  return map;
}

async function salesByProduct(c) {
  const { sales: rows } = await loadSales(c, { ignoreItems: true });
  const [cat, returned] = await Promise.all([catalog(), returnsBySaleLine(rows.map((x) => x._id))]);
  const by = new Map();
  for (const x of rows) {
    for (const l of x.lines) {
      const v = cat.get(s(l.variantId));
      if (filtersItems(c) && !matches(c, v)) continue;
      const id = s(l.variantId);
      const r = by.get(id) ?? { item: v ? nameOf(v) : l.description, code: v?.code ?? l.code, category: v?.category ?? null, qty: 0, returned: 0, discount: 0, vat: 0, total: 0, refunded: 0 };
      r.qty += l.quantity;
      r.discount += Number(l.discountAmount);
      r.vat += Number(l.taxAmount);
      r.total += Number(l.total);
      for (const ret of returned.get(s(l._id)) ?? []) {
        r.returned += ret.quantity;
        r.refunded += ret.total;
      }
      by.set(id, r);
    }
  }
  return {
    columns: [
      col("item", "Item"),
      col("code", "Code"),
      col("category", "Category"),
      col("qty", "Sold", "number", true),
      col("returned", "Returned", "number", true),
      col("discount", "Discount", "money", true),
      col("vat", "VAT", "money", true),
      col("total", "Sold value", "money", true),
      col("net", "After returns", "money", true),
    ],
    rows: [...by.values()]
      .sort((a, b) => b.total - a.total)
      .map((r) => ({
        item: r.item,
        code: r.code,
        category: r.category,
        qty: r.qty,
        returned: r.returned,
        discount: round2(r.discount),
        vat: round2(r.vat),
        total: round2(r.total),
        net: round2(r.total - r.refunded),
      })),
  };
}

async function returns(c) {
  const filter = { ...when("createdAt", c.created) };
  if (c.f.userId) filter.cashierId = c.f.userId;
  const notes = await CreditNote.find(filter).sort({ createdAt: 1 }).lean();
  const [saleRows, names, cat] = await Promise.all([
    Sale.find({ _id: { $in: notes.map((n) => n.saleId) } }).select("invoiceNumber lines").lean(),
    namesOf(notes.map((n) => n.cashierId)),
    filtersItems(c) ? catalog() : null,
  ]);
  const saleById = new Map(saleRows.map((x) => [s(x._id), x]));
  const rows = [];
  for (const n of notes) {
    const sale = saleById.get(s(n.saleId));
    for (const l of n.lines) {
      const line = sale?.lines.find((x) => s(x._id) === s(l.saleLineId));
      if (cat && !matches(c, cat.get(s(line?.variantId)))) continue;
      rows.push({
        date: iso(n.createdAt),
        creditNote: n.creditNumber,
        invoice: sale?.invoiceNumber ?? null,
        item: line?.description ?? "?",
        code: line?.code ?? null,
        qty: l.quantity,
        condition: l.condition === "GOOD" ? "Good" : "Damaged",
        backTo: c.paths.get(s(l.locationId))?.path ?? null,
        vat: num(l.taxAmount),
        refund: num(l.total),
        method: PAYMENT_LABELS[n.refundMethod],
        by: names.get(s(n.cashierId)) ?? null,
        reason: n.reason,
      });
    }
  }
  return {
    columns: [
      col("date", "Date", "datetime"),
      col("creditNote", "Credit note"),
      col("invoice", "Invoice"),
      col("item", "Item"),
      col("code", "Code"),
      col("qty", "Qty", "number", true),
      col("condition", "Condition"),
      col("backTo", "Back to"),
      col("vat", "VAT", "money", true),
      col("refund", "Refund", "money", true),
      col("method", "Refunded by"),
      col("by", "Processed by"),
      col("reason", "Reason"),
    ],
    rows,
  };
}

// ---------------------------------------------------------------- stock

async function inventory(c) {
  const showCost = COST_ROLES.includes(c.user.role);
  const scope = c.f.locationId ? new Set(scopeIds(c)) : null;
  const cat = await catalog();
  const levels = await StockLevel.find().lean();
  const levelsBy = new Map();
  for (const l of levels) {
    const list = levelsBy.get(s(l.variantId)) ?? [];
    list.push(l);
    levelsBy.set(s(l.variantId), list);
  }
  const rows = [];
  for (const v of cat.values()) {
    if (!["STANDARD", "COMPONENT"].includes(v.kind) || v.status !== "ACTIVE" || !matches(c, v)) continue;
    let store = 0;
    let reserved = 0;
    let transit = 0;
    let damaged = 0;
    for (const l of levelsBy.get(v.id) ?? []) {
      const loc = c.paths.get(s(l.locationId));
      if (!loc) continue;
      if (loc.type === "TRANSIT") transit += l.onHand;
      else if (loc.type === "DAMAGED") damaged += l.onHand;
      else if (!scope || scope.has(loc.id)) {
        store += l.onHand;
        reserved += l.reserved;
      }
    }
    if (scope && store === 0) continue;
    const cost = num(v.costPrice);
    rows.push({
      item: nameOf(v),
      code: v.code,
      sku: v.sku,
      category: v.category,
      store,
      reserved,
      available: store - reserved,
      transit: scope ? null : transit,
      damaged: scope ? null : damaged,
      ...(showCost && { cost, value: cost === null ? null : round2(cost * store) }),
    });
  }
  rows.sort((a, b) => String(a.item).localeCompare(String(b.item)));
  return {
    columns: [
      col("item", "Item"),
      col("code", "Code"),
      col("sku", "SKU"),
      col("category", "Category"),
      col("store", scope ? "On hand here" : "In store", "number", true),
      col("reserved", "Reserved", "number", true),
      col("available", "Available", "number", true),
      ...(scope ? [] : [col("transit", "In transit", "number", true), col("damaged", "Damaged", "number", true)]),
      ...(showCost ? [col("cost", "Cost price", "money"), col("value", "Stock value (cost)", "money", true)] : []),
    ],
    rows,
  };
}

async function stockByLocation(c) {
  const ids = c.f.locationId ? scopeIds(c) : c.all.filter((l) => !SYSTEM_TYPES.includes(l.type)).map((l) => l.id);
  const [levels, cat] = await Promise.all([StockLevel.find({ locationId: { $in: ids }, onHand: { $gt: 0 } }).lean(), catalog()]);
  return {
    columns: [
      col("site", "Site"),
      col("location", "Location"),
      col("item", "Item"),
      col("code", "Code"),
      col("onHand", "On hand", "number", true),
      col("reserved", "Reserved", "number", true),
      col("available", "Available", "number", true),
    ],
    rows: levels
      .filter((l) => matches(c, cat.get(s(l.variantId))))
      .map((l) => {
        const loc = c.paths.get(s(l.locationId));
        const v = cat.get(s(l.variantId));
        return {
          site: loc.pathNames[0],
          location: loc.pathNames.slice(1).join(" › ") || loc.name,
          item: nameOf(v),
          code: v.code,
          onHand: l.onHand,
          reserved: l.reserved,
          available: l.onHand - l.reserved,
        };
      })
      .sort((a, b) => collator.compare(`${a.site} ${a.location}`, `${b.site} ${b.location}`) || collator.compare(a.item, b.item)),
  };
}

async function lowStockReport(c) {
  let rows = await lowStock();
  if (c.f.categoryId) {
    const ids = new Set((await Product.find({ categoryId: c.f.categoryId }).distinct("_id")).map(String));
    rows = rows.filter((r) => ids.has(String(r.productId)));
  }
  return {
    columns: [col("item", "Item"), col("code", "Code"), col("available", "Available", "number"), col("minStock", "Minimum", "number"), col("short", "Short by", "number", true)],
    rows: rows.map((r) => ({ item: r.name, code: r.code, available: r.available, minStock: r.minStock, short: r.minStock - r.available })),
  };
}

async function movements(c) {
  const filter = { ...when("createdAt", c.created) };
  if (c.f.userId) filter.userId = c.f.userId;
  if (c.f.locationId) {
    const ids = scopeIds(c);
    filter.$or = [{ fromLocationId: { $in: ids } }, { toLocationId: { $in: ids } }];
  }
  const cat = await catalog();
  if (filtersItems(c)) filter.variantId = { $in: [...cat.values()].filter((v) => matches(c, v)).map((v) => v._id) };
  const moves = await StockMovement.find(filter).sort({ createdAt: 1 }).limit(MAX_ROWS + 1).lean();
  const names = await namesOf(moves.map((m) => m.userId));
  const path = (id) => (id ? (c.paths.get(s(id))?.path ?? "?") : null);
  return {
    columns: [
      col("date", "Date", "datetime"),
      col("type", "Type"),
      col("item", "Item"),
      col("code", "Code"),
      col("qty", "Qty", "number"),
      col("from", "From"),
      col("to", "To"),
      col("user", "Done by"),
      col("reason", "Reason"),
      col("reference", "Reference"),
      col("note", "Note"),
    ],
    rows: moves.map((m) => {
      const v = cat.get(s(m.variantId));
      return {
        date: iso(m.createdAt),
        type: MOVEMENT_LABELS[m.type],
        item: nameOf(v),
        code: v?.code ?? null,
        qty: m.quantity,
        from: path(m.fromLocationId),
        to: path(m.toLocationId),
        user: m.userId ? (names.get(s(m.userId)) ?? null) : null,
        reason: m.reason,
        reference: m.reference,
        note: m.note,
      };
    }),
  };
}

async function damaged(c) {
  const damagedIds = c.all.filter((l) => l.type === "DAMAGED").map((l) => l.id);
  const [levels, cat] = await Promise.all([StockLevel.find({ locationId: { $in: damagedIds }, onHand: { $gt: 0 } }).lean(), catalog()]);
  const shown = levels.filter((l) => matches(c, cat.get(s(l.variantId))));
  const last = await StockMovement.aggregate([
    { $match: { toLocationId: { $in: damagedIds.map((id) => new Order.base.Types.ObjectId(id)) }, variantId: { $in: shown.map((l) => l.variantId) } } },
    { $group: { _id: "$variantId", at: { $max: "$createdAt" } } },
  ]);
  const lastBy = new Map(last.map((l) => [s(l._id), l.at]));
  const showCost = COST_ROLES.includes(c.user.role);
  return {
    columns: [
      col("item", "Item"),
      col("code", "Code"),
      col("qty", "Damaged", "number", true),
      col("last", "Last damaged", "datetime"),
      ...(showCost ? [col("value", "Value (cost)", "money", true)] : []),
    ],
    rows: shown.map((l) => {
      const v = cat.get(s(l.variantId));
      return {
        item: nameOf(v),
        code: v.code,
        qty: l.onHand,
        last: iso(lastBy.get(s(l.variantId))),
        ...(showCost && { value: v.costPrice === null || v.costPrice === undefined ? null : round2(Number(v.costPrice) * l.onHand) }),
      };
    }),
  };
}

async function stocktakeVariance(c) {
  const takes = await Stocktake.find({ status: "APPROVED", ...when("approvedAt", c.created) }).sort({ approvedAt: 1 }).lean();
  const lineFilter = { stocktakeId: { $in: takes.map((t) => t._id) }, adjustment: { $nin: [0, null] } };
  if (c.f.locationId) lineFilter.locationId = { $in: scopeIds(c) };
  const [lines, cat, names] = await Promise.all([
    StocktakeLine.find(lineFilter).lean(),
    catalog(),
    namesOf(takes.map((t) => t.approvedById)),
  ]);
  const takeById = new Map(takes.map((t) => [s(t._id), t]));
  return {
    columns: [
      col("date", "Approved", "datetime"),
      col("stocktake", "Stocktake"),
      col("location", "Location"),
      col("item", "Item"),
      col("code", "Code"),
      col("system", "System (at count)", "number"),
      col("counted", "Counted", "number"),
      col("adjustment", "Correction", "number", true),
      col("approvedBy", "Approved by"),
    ],
    rows: lines
      .filter((l) => matches(c, cat.get(s(l.variantId))))
      .map((l) => {
        const t = takeById.get(s(l.stocktakeId));
        const v = cat.get(s(l.variantId));
        return {
          date: iso(t.approvedAt),
          stocktake: t.code,
          location: c.paths.get(s(l.locationId))?.path ?? "?",
          item: nameOf(v),
          code: v.code,
          system: l.onHandAtCount ?? l.expected,
          counted: l.counted,
          adjustment: l.adjustment,
          approvedBy: names.get(s(t.approvedById)) ?? null,
        };
      })
      .sort((a, b) => String(a.date).localeCompare(String(b.date))),
  };
}

async function incompleteKits(c) {
  const cat = await catalog();
  const kits = [...cat.values()].filter((v) => v.kind === "KIT" && v.active && v.status === "ACTIVE" && matches(c, v));
  const boxIds = kits.flatMap((k) => k.components.map((x) => x.componentVariantId));
  const levels = await StockLevel.find({ variantId: { $in: boxIds } }).lean();
  const rows = [];
  for (const kit of kits) {
    const boxes = kit.components.map((comp) => ({
      variantId: s(comp.componentVariantId),
      perKit: comp.quantity,
      available: levels
        .filter((l) => s(l.variantId) === s(comp.componentVariantId) && !SYSTEM_TYPES.includes(c.paths.get(s(l.locationId))?.type))
        .reduce((n, l) => n + l.onHand - l.reserved, 0),
    }));
    const { sellable, boxes: result } = kitAvailability(boxes);
    if (!result.some((b) => b.spare > 0)) continue;
    for (const b of result) {
      const box = cat.get(b.variantId);
      rows.push({ kit: kit.product, box: (box?.name ?? "?").split(" – ")[0], code: box?.code ?? null, perKit: b.perKit, available: b.available, complete: sellable, spare: b.spare });
    }
  }
  return {
    columns: [
      col("kit", "Kit"),
      col("box", "Box"),
      col("code", "Code"),
      col("perKit", "Per kit", "number"),
      col("available", "Available", "number"),
      col("complete", "Complete kits", "number"),
      col("spare", "Spare (incomplete)", "number", true),
    ],
    rows,
  };
}

// ---------------------------------------------------------------- orders

async function orders(c) {
  const filter = { ...when("createdAt", c.created) };
  if (c.f.userId) filter.driverId = c.f.userId;
  if (c.f.productId) filter["lines.variantId"] = { $in: await Variant.find({ productId: c.f.productId }).distinct("_id") };
  const rows = await Order.find(filter).sort({ createdAt: 1 }).limit(MAX_ROWS + 1).lean();
  const names = await namesOf(rows.map((o) => o.driverId));
  return {
    columns: [
      col("date", "Created", "datetime"),
      col("order", "Order"),
      col("source", "Source"),
      col("customer", "Customer"),
      col("status", "Status"),
      col("driver", "Driver"),
      col("deliveryDate", "Delivery date", "date"),
      col("items", "Items", "number", true),
      col("payment", "Payment"),
      col("cod", "Cash to collect", "money", true),
    ],
    rows: rows.map((o) => ({
      date: iso(o.createdAt),
      order: o.orderNumber,
      source: o.source === "WEBSITE" ? `Website #${o.externalId}` : "Manual",
      customer: o.customerName,
      status: ORDER_LABELS[o.status],
      driver: o.driverId ? (names.get(s(o.driverId)) ?? null) : null,
      deliveryDate: o.deliveryDate ? o.deliveryDate.slice(0, 10) : null,
      items: o.lines.reduce((n, l) => n + l.quantity, 0),
      payment: o.paymentStatus === "COD" ? "Cash on delivery" : o.paymentStatus === "PAID" ? "Paid" : "Not paid",
      cod: o.paymentStatus === "COD" ? num(o.codAmount) : null,
    })),
  };
}

/** Everything In Transit right now, split by driver's van (orders) and by transfer. */
async function inTransit(c) {
  const orderFilter = { "allocations.picked": { $gt: 0 } };
  if (c.f.userId) orderFilter.driverId = c.f.userId;
  const [orderRows, transfers, cat] = await Promise.all([
    Order.find(orderFilter).lean(),
    c.f.userId ? [] : Transfer.find({ status: "IN_TRANSIT" }).lean(),
    catalog(),
  ]);
  const names = await namesOf([...orderRows.map((o) => o.driverId), ...transfers.map((t) => t.sentById)]);
  const rows = [];
  for (const o of orderRows) {
    for (const a of o.allocations) {
      const qty = a.picked - a.delivered - a.returned;
      if (qty <= 0) continue;
      const v = cat.get(s(a.variantId));
      rows.push({
        on: o.driverId ? `🚚 ${names.get(s(o.driverId)) ?? "?"}` : "🚚 (no driver)",
        reference: o.orderNumber,
        detail: `${ORDER_LABELS[o.status]} · ${o.customerName}`,
        item: nameOf(v),
        code: v?.code ?? null,
        qty,
      });
    }
  }
  for (const t of transfers) {
    for (const l of t.lines) {
      const qty = l.quantity - l.received - l.lost;
      if (qty <= 0) continue;
      const v = cat.get(s(l.variantId));
      const from = c.paths.get(s(t.fromLocationId))?.path ?? "?";
      const to = c.paths.get(s(t.toLocationId))?.path ?? "?";
      rows.push({ on: "↔ Transfer", reference: t.code, detail: `${from} → ${to} (sent by ${names.get(s(t.sentById)) ?? "?"})`, item: nameOf(v), code: v?.code ?? null, qty });
    }
  }
  rows.sort((a, b) => String(a.on).localeCompare(String(b.on)) || String(a.reference).localeCompare(String(b.reference)));
  return {
    columns: [col("on", "On"), col("reference", "Order / transfer"), col("detail", "Details"), col("item", "Item"), col("code", "Code"), col("qty", "Qty", "number", true)],
    rows,
  };
}

async function deliveries(c) {
  const filter = {
    $or: [
      { status: "DELIVERED", ...when("deliveredAt", c.created) },
      { status: { $in: ["FAILED", "RETURNED"] }, ...when("updatedAt", c.created) },
    ],
  };
  if (c.f.userId) filter.driverId = c.f.userId;
  const rows = await Order.find(filter).sort({ updatedAt: 1 }).limit(MAX_ROWS + 1).lean();
  const names = await namesOf(rows.flatMap((o) => [o.driverId, o.deliveredById, o.partialApprovedById]));
  const name = (id) => (id ? (names.get(s(id)) ?? null) : null);
  return {
    columns: [
      col("order", "Order"),
      col("customer", "Customer"),
      col("driver", "Driver"),
      col("status", "Result"),
      col("deliveredAt", "Delivered", "datetime"),
      col("recipient", "Received by"),
      col("codExpected", "Cash expected", "money", true),
      col("codCollected", "Cash collected", "money", true),
      col("codDiff", "Difference", "money", true),
      col("partial", "Partial — approved by"),
      col("failed", "Failed reason"),
      col("problems", "Problems reported", "number", true),
    ],
    rows: rows.map((o) => {
      const expected = o.paymentStatus === "COD" ? Number(o.codAmount ?? 0) : null;
      const collected = num(o.codCollected);
      return {
        order: o.orderNumber,
        customer: o.customerName,
        driver: name(o.driverId) ?? name(o.deliveredById),
        status: ORDER_LABELS[o.status],
        deliveredAt: iso(o.deliveredAt),
        recipient: o.recipientName,
        codExpected: expected,
        codCollected: collected,
        codDiff: expected !== null && collected !== null ? round2(collected - expected) : null,
        partial: name(o.partialApprovedById),
        failed: o.failedReason,
        problems: o.exceptions.length,
      };
    }),
  };
}

// ---------------------------------------------------------------- control

async function auditRows(c, actions, limit) {
  const filter = { action: { $in: actions }, ...when("createdAt", c.created) };
  if (c.f.userId) filter.userId = c.f.userId;
  const logs = await AuditLog.find(filter).sort({ createdAt: 1 }).limit(limit).lean();
  return { logs, names: await namesOf(logs.map((l) => l.userId)) };
}

async function pickingErrors(c) {
  const { logs, names } = await auditRows(c, ["PICK_REJECTED"], MAX_ROWS + 1);
  const REASONS = {
    WRONG_LOCATION: "Wrong place",
    ALREADY_PICKED: "Too many",
    WRONG_ITEM: "Wrong item",
    WRONG_BOX: "Wrong box",
    UNKNOWN_CODE: "Unknown code",
    NOT_PICKABLE: "Order not ready to pick",
    OTHER: "Other",
  };
  return {
    columns: [col("date", "Date", "datetime"), col("user", "Picker"), col("order", "Order"), col("code", "Scanned"), col("location", "At"), col("reason", "Error"), col("message", "Details")],
    rows: logs.map((l) => {
      const d = l.data ?? {};
      return {
        date: iso(l.createdAt),
        user: l.userId ? (names.get(s(l.userId)) ?? null) : null,
        order: d.orderNumber ?? null,
        code: d.code ?? null,
        location: d.locationId ? (c.paths.get(d.locationId)?.path ?? null) : null,
        reason: REASONS[d.reason] ?? d.reason ?? null,
        message: d.message ?? null,
      };
    }),
  };
}

async function overrides(c) {
  const ACTIONS = {
    PICK_LOCATION_OVERRIDE: "Picked from a different place",
    ORDER_SHORT_APPROVED: "Sent with items missing",
    ORDER_DELIVERED_PARTIAL: "Partial delivery",
    SALE_COMPLETED: "Discount above limit",
    STOCKTAKE_APPROVED: "Stocktake approved",
  };
  const { logs, names } = await auditRows(c, Object.keys(ACTIONS), MAX_ROWS * 2);
  // A sale is only an override when a manager approved its discount.
  const relevant = logs.filter((l) => l.action !== "SALE_COMPLETED" || l.data?.approvedById);
  const approvers = await namesOf(relevant.map((l) => l.data?.approvedById ?? l.data?.partialApprovedById));
  return {
    columns: [col("date", "Date", "datetime"), col("type", "Override"), col("user", "Done by"), col("approvedBy", "Approved by"), col("reference", "Reference"), col("details", "Details")],
    rows: relevant.map((l) => {
      const d = l.data ?? {};
      const approver = d.approvedById ?? d.partialApprovedById;
      const doneBy = l.userId ? (names.get(s(l.userId)) ?? null) : null;
      return {
        date: iso(l.createdAt),
        type: ACTIONS[l.action],
        user: doneBy,
        approvedBy: approver ? (approvers.get(String(approver)) ?? null) : l.action === "STOCKTAKE_APPROVED" ? doneBy : null,
        reference: d.orderNumber ?? d.invoiceNumber ?? d.code ?? null,
        details:
          [
            d.item,
            d.reason,
            d.expectedFrom && `expected ${d.expectedFrom}, taken from ${d.pickedFrom}`,
            d.missing && `${d.missing} missing`,
            d.notDelivered && `${d.notDelivered} not delivered`,
            d.adjustments !== undefined && `${d.adjustments} correction(s)`,
          ]
            .filter(Boolean)
            .join(" · ") || null,
      };
    }),
  };
}

const BUILDERS = {
  sales,
  "sales-by-day": salesByDay,
  "channel-summary": channelSummary,
  "sales-by-cashier": salesByCashier,
  "sales-by-product": salesByProduct,
  returns,
  inventory,
  "stock-by-location": stockByLocation,
  "low-stock": lowStockReport,
  movements,
  damaged,
  "stocktake-variance": stocktakeVariance,
  "incomplete-kits": incompleteKits,
  orders,
  "in-transit": inTransit,
  deliveries,
  "picking-errors": pickingErrors,
  overrides,
};

// ---------------------------------------------------------------- Excel

const FORMATS = { money: "#,##0.00", number: "#,##0", datetime: "dd/mm/yyyy hh:mm", date: "dd/mm/yyyy" };

/** A real .xlsx: title, filters used, bold header, typed cells (dates/money), totals row. */
export async function reportToXlsx(report, subtitle, businessName) {
  const wb = new ExcelJS.Workbook();
  wb.creator = businessName;
  wb.created = new Date();
  const ws = wb.addWorksheet(report.title.replace(/[\\/?*[\]:]/g, "").slice(0, 31));

  ws.addRow([`${businessName} — ${report.title}`]).font = { bold: true, size: 14 };
  ws.addRow([subtitle]).font = { color: { argb: "FF666666" } };
  if (report.truncated) {
    ws.addRow([`Only the first ${report.rows.length} rows are included — narrow the filters to see the rest.`]).font = { color: { argb: "FFC42B2B" } };
  }
  ws.addRow([]);

  const header = ws.addRow(report.columns.map((c) => c.label));
  header.font = { bold: true };
  header.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F5F9" } };
    cell.border = { bottom: { style: "thin", color: { argb: "FFD9DEE8" } } };
  });
  const headerRow = header.number;

  for (const row of report.rows) {
    ws.addRow(
      report.columns.map((c) => {
        const v = row[c.key];
        if (v === null || v === undefined || v === "") return null;
        if (c.type === "datetime") return maltaWallClock(new Date(String(v)));
        if (c.type === "date") return new Date(`${String(v).slice(0, 10)}T00:00:00Z`);
        return v;
      })
    );
  }
  if (report.totals) {
    const totals = ws.addRow(report.columns.map((c, i) => (i === 0 ? "Total" : (report.totals[c.key] ?? null))));
    totals.font = { bold: true };
    totals.eachCell((cell) => (cell.border = { top: { style: "thin" } }));
  }

  report.columns.forEach((c, i) => {
    const column = ws.getColumn(i + 1);
    if (c.type !== "text") column.numFmt = FORMATS[c.type];
    const longest = Math.max(c.label.length, ...report.rows.slice(0, 500).map((r) => String(r[c.key] ?? "").length));
    column.width = Math.min(50, Math.max(10, c.type === "datetime" ? 17 : longest + 2));
  });
  ws.views = [{ state: "frozen", ySplit: headerRow }];
  ws.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: headerRow, column: report.columns.length } };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** "1 Oct 2026 – 31 Oct 2026 · Hamrun Shop · Maria" for the top of the sheet. */
export async function describeFilters(q) {
  const bits = [];
  const fmt = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  if (q.from || q.to) bits.push(`${q.from ? fmt(q.from) : "start"} – ${q.to ? fmt(q.to) : "today"}`);
  if (q.locationId) bits.push((await withPaths()).find((l) => l.id === q.locationId)?.path ?? "");
  if (q.productId) bits.push((await Product.findById(q.productId).select("name").lean())?.name ?? "");
  if (q.categoryId) bits.push((await Category.findById(q.categoryId).select("name").lean())?.name ?? "");
  if (q.userId) bits.push((await User.findById(q.userId).select("name").lean())?.name ?? "");
  bits.push(`generated ${new Date().toLocaleString("en-GB", { timeZone: TIMEZONE })}`);
  return bits.filter(Boolean).join(" · ");
}
