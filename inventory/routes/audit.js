// inventory/routes/audit.js — read-only view of the audit trail. There is no endpoint to change or delete it.
import express from "express";
import { z } from "zod";
import { allow } from "../auth/auth.js";
import { AUDIT_READ } from "../auth/roles.js";
import { dayRange } from "../lib/dates.js";
import { ah } from "../lib/http.js";
import { send } from "../lib/json.js";
import { escapeRegex, parse, zDate, zId, zQueryInt } from "../lib/validate.js";
import AuditLog from "../models/AuditLog.js";

const router = express.Router();
router.use(allow(AUDIT_READ));

const AuditQuery = z.object({
  from: zDate.optional(),
  to: zDate.optional(),
  userId: zId.optional(),
  action: z.string().max(60).optional(),
  entity: z.string().max(60).optional(),
  /** Matches the record id, or text inside the details (e.g. an order or invoice number). */
  q: z.string().max(100).optional(),
  page: zQueryInt(1, 100000).optional(),
  pageSize: zQueryInt(1, 200).optional(),
});

router.get(
  "/",
  ah(async (req, res) => {
    const query = parse(AuditQuery, req.query);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;
    const filter = {};
    const createdAt = dayRange(query.from, query.to);
    if (createdAt) filter.createdAt = createdAt;
    if (query.userId) filter.userId = query.userId;
    if (query.action) filter.action = query.action;
    if (query.entity) filter.entity = query.entity;
    const q = query.q?.trim();
    if (q) filter.$or = [{ entityId: q }, { searchText: new RegExp(escapeRegex(q), "i") }];

    const [items, total] = await Promise.all([
      AuditLog.find(filter)
        .select("-searchText")
        .sort({ createdAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .populate("userId", "name role")
        .lean(),
      AuditLog.countDocuments(filter),
    ]);
    send(res, { items: items.map(withUser), total, page, pageSize });
  })
);

/** The distinct actions and record types, for the filter drop-downs. */
router.get(
  "/facets",
  ah(async (req, res) => {
    const [actions, entities] = await Promise.all([AuditLog.distinct("action"), AuditLog.distinct("entity")]);
    res.json({ actions: actions.sort(), entities: entities.sort() });
  })
);

/** { userId: {…populated} } → { userId, user } like the original API. */
function withUser(row) {
  const u = row.userId;
  return { ...row, userId: u?._id ?? u ?? null, user: u?._id ? { id: u._id, name: u.name, role: u.role } : null };
}

export default router;
