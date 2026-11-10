// inventory/routes/users.js — staff accounts. Accounts are deactivated, never deleted.
import express from "express";
import { z } from "zod";
import { allow } from "../auth/auth.js";
import { canManageRole } from "../auth/roles.js";
import { isDuplicateKey, withTransaction } from "../lib/db.js";
import { ah, badRequest, conflict, forbidden, notFound } from "../lib/http.js";
import { send } from "../lib/json.js";
import { hashPassword, normalizePhone } from "../lib/password.js";
import {
  escapeRegex,
  idParam,
  parse,
  PASSWORD_MIN_LENGTH,
  PHONE_PATTERN,
  zBoolString,
  zId,
} from "../lib/validate.js";
import Location from "../models/Location.js";
import User, { PUBLIC_USER_FIELDS, ROLES } from "../models/User.js";
import { audit } from "../services/audit.js";

const router = express.Router();
router.use(allow("ADMIN", "MANAGER"));

const zSiteIds = z.array(zId).max(50);
const zPhone = z.string().regex(PHONE_PATTERN, "phone must be a valid phone number");

const ListQuery = z.object({
  q: z.string().max(100).optional(),
  role: z.enum(ROLES).optional(),
  active: zBoolString.optional(),
});

const CreateBody = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(200).optional(),
  phone: zPhone.optional(),
  role: z.enum(ROLES),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(200),
  /** Sites this person may change stock in; omit or [] = all sites. */
  siteIds: zSiteIds.optional(),
});

/** Send `null` for email/phone to clear it. */
const UpdateBody = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  email: z.string().trim().email().max(200).nullable().optional(),
  phone: zPhone.nullable().optional(),
  role: z.enum(ROLES).optional(),
  siteIds: zSiteIds.optional(),
});

router.get(
  "/",
  ah(async (req, res) => {
    const query = parse(ListQuery, req.query);
    const filter = {};
    if (query.role) filter.role = query.role;
    if (query.active !== undefined) filter.active = query.active;
    const q = query.q?.trim();
    if (q) {
      const rx = new RegExp(escapeRegex(q), "i");
      filter.$or = [{ name: rx }, { email: rx }, { phone: new RegExp(escapeRegex(q)) }];
    }
    const users = await User.find(filter).select(PUBLIC_USER_FIELDS).sort({ active: -1, name: 1 }).lean();
    send(res, users);
  })
);

/** Roles the current user is allowed to assign — used to build the role dropdown. */
router.get("/assignable-roles", (req, res) => {
  res.json(ROLES.filter((r) => canManageRole(req.staff.role, r)));
});

router.get(
  "/:id",
  ah(async (req, res) => {
    const user = await User.findById(idParam(req.params.id)).select(PUBLIC_USER_FIELDS).lean();
    if (!user) throw notFound("User not found");
    send(res, user);
  })
);

router.post(
  "/",
  ah(async (req, res) => {
    const actor = req.staff;
    const dto = parse(CreateBody, req.body);
    assertCanManageRole(actor, dto.role);
    const email = dto.email ? dto.email.toLowerCase() : undefined;
    const phone = dto.phone ? normalizePhone(dto.phone) : undefined;
    if (!email && !phone) throw badRequest("Enter an email or a phone number");

    const siteIds = await validSites(dto.siteIds);
    const passwordHash = await hashPassword(dto.password);
    const created = await uniqueGuard(() =>
      User.create({ name: dto.name, email, phone, role: dto.role, passwordHash, siteIds })
    );
    await audit({
      userId: actor.id,
      action: "USER_CREATED",
      entity: "User",
      entityId: created._id,
      data: { name: created.name, email: email ?? null, phone: phone ?? null, role: created.role, siteIds },
    });
    send(res, await User.findById(created._id).select(PUBLIC_USER_FIELDS).lean(), 201);
  })
);

router.patch(
  "/:id",
  ah(async (req, res) => {
    const actor = req.staff;
    const id = idParam(req.params.id);
    const dto = parse(UpdateBody, req.body);
    const target = await findTarget(actor, id);

    if (dto.role && dto.role !== target.role) {
      if (String(target._id) === actor.id) throw forbidden("You cannot change your own role");
      assertCanManageRole(actor, dto.role);
    }

    const set = {};
    const unset = {};
    if (dto.name !== undefined) set.name = dto.name;
    if (dto.email !== undefined) dto.email ? (set.email = dto.email.toLowerCase()) : (unset.email = 1);
    if (dto.phone !== undefined) dto.phone ? (set.phone = normalizePhone(dto.phone)) : (unset.phone = 1);
    if (dto.role !== undefined) set.role = dto.role;
    if (dto.siteIds !== undefined) set.siteIds = await validSites(dto.siteIds);

    const nextEmail = dto.email !== undefined ? set.email : target.email;
    const nextPhone = dto.phone !== undefined ? set.phone : target.phone;
    if (!nextEmail && !nextPhone) throw badRequest("A user needs an email or a phone number");

    const user = await withTransaction(async (session) => {
      if (target.role === "ADMIN" && dto.role && dto.role !== "ADMIN") {
        await assertAnotherActiveAdmin(target._id, session);
      }
      const update = {};
      if (Object.keys(set).length) update.$set = set;
      if (Object.keys(unset).length) update.$unset = unset;
      return uniqueGuard(() =>
        User.findByIdAndUpdate(id, update, { new: true, session })
          .select(PUBLIC_USER_FIELDS)
          .lean()
      );
    });

    await audit({
      userId: actor.id,
      action: "USER_UPDATED",
      entity: "User",
      entityId: id,
      data: {
        before: snapshot(target),
        after: snapshot(user),
      },
    });
    send(res, user);
  })
);

router.patch(
  "/:id/active",
  ah(async (req, res) => {
    const actor = req.staff;
    const id = idParam(req.params.id);
    const { active } = parse(z.object({ active: z.boolean() }), req.body);
    const target = await findTarget(actor, id);
    if (String(target._id) === actor.id && !active) throw forbidden("You cannot deactivate your own account");

    const user = await withTransaction(async (session) => {
      if (!active && target.role === "ADMIN") await assertAnotherActiveAdmin(target._id, session);
      return User.findByIdAndUpdate(id, { active }, { new: true, session }).select(PUBLIC_USER_FIELDS).lean();
    });
    await audit({ userId: actor.id, action: active ? "USER_ACTIVATED" : "USER_DEACTIVATED", entity: "User", entityId: id });
    send(res, user);
  })
);

router.post(
  "/:id/reset-password",
  ah(async (req, res) => {
    const actor = req.staff;
    const id = idParam(req.params.id);
    const { newPassword } = parse(z.object({ newPassword: z.string().min(PASSWORD_MIN_LENGTH).max(200) }), req.body);
    await findTarget(actor, id);
    await User.updateOne({ _id: id }, { passwordHash: await hashPassword(newPassword) });
    await audit({ userId: actor.id, action: "PASSWORD_RESET", entity: "User", entityId: id });
    res.status(204).end();
  })
);

// ------------------------------------------------------------------ helpers

async function findTarget(actor, id) {
  const target = await User.findById(id).lean();
  if (!target) throw notFound("User not found");
  if (String(target._id) !== actor.id) assertCanManageRole(actor, target.role);
  return target;
}

function assertCanManageRole(actor, role) {
  if (!canManageRole(actor.role, role)) throw forbidden(`You cannot manage users with the ${role} role`);
}

/** Site restrictions must point at real, top-level sites. */
async function validSites(siteIds) {
  const ids = [...new Set(siteIds ?? [])];
  if (!ids.length) return [];
  const found = await Location.countDocuments({ _id: { $in: ids }, type: "SITE" });
  if (found !== ids.length) throw badRequest("Choose sites (garages / shops) only");
  return ids;
}

async function assertAnotherActiveAdmin(excludeId, session) {
  const others = await User.countDocuments({ role: "ADMIN", active: true, _id: { $ne: excludeId } }).session(session);
  if (others === 0) throw badRequest("There must always be at least one active admin");
}

async function uniqueGuard(fn) {
  try {
    return await fn();
  } catch (e) {
    if (isDuplicateKey(e)) {
      const field = Object.keys(e.keyPattern || {}).join(", ") || "value";
      throw conflict(`This ${field} is already used by another user`);
    }
    throw e;
  }
}

function snapshot(u) {
  return {
    name: u.name,
    email: u.email ?? null,
    phone: u.phone ?? null,
    role: u.role,
    siteIds: (u.siteIds || []).map(String),
  };
}

export default router;
