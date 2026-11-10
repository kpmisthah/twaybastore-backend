// inventory/routes/auth.js — staff login, current user, change own password.
import { randomUUID } from "node:crypto";
import express from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { requireStaff, signToken } from "../auth/auth.js";
import { ah, badRequest, unauthorized } from "../lib/http.js";
import { send } from "../lib/json.js";
import { hashPassword, normalizePhone, verifyPassword } from "../lib/password.js";
import { parse, PASSWORD_MIN_LENGTH } from "../lib/validate.js";
import User, { PUBLIC_USER_FIELDS } from "../models/User.js";
import { audit } from "../services/audit.js";

const router = express.Router();

// Compared against when the login does not exist, so response time does not
// reveal which emails/phones are registered.
const dummyHash = hashPassword(randomUUID());

const loginLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many login attempts, try again in a minute" },
});

const LoginBody = z.object({
  /** Email or phone number. */
  login: z.string().trim().min(1).max(200),
  password: z.string().min(1).max(200),
});

/** Finds a staff user by email or phone. */
export function findByLogin(login) {
  const identifier = login.trim();
  return User.findOne({ $or: [{ email: identifier.toLowerCase() }, { phone: normalizePhone(identifier) }] });
}

router.post(
  "/login",
  loginLimiter,
  ah(async (req, res) => {
    const { login, password } = parse(LoginBody, req.body);
    const user = await findByLogin(login);

    const ok = await verifyPassword(password, user?.passwordHash ?? (await dummyHash));
    if (!user || !ok || !user.active) {
      if (user) {
        await audit({
          userId: user._id,
          action: user.active ? "LOGIN_FAILED" : "LOGIN_BLOCKED_INACTIVE",
          entity: "User",
          entityId: user._id,
        });
      }
      throw unauthorized("Wrong login or password");
    }

    user.lastLoginAt = new Date();
    await user.save();
    await audit({ userId: user._id, action: "LOGIN", entity: "User", entityId: user._id });

    const publicUser = await User.findById(user._id).select(PUBLIC_USER_FIELDS).lean();
    send(res, { accessToken: signToken(user), user: publicUser });
  })
);

router.get(
  "/me",
  requireStaff,
  ah(async (req, res) => {
    send(res, await User.findById(req.staff.id).select(PUBLIC_USER_FIELDS).lean());
  })
);

const ChangePasswordBody = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(PASSWORD_MIN_LENGTH).max(200),
});

router.post(
  "/change-password",
  requireStaff,
  ah(async (req, res) => {
    const dto = parse(ChangePasswordBody, req.body);
    const user = await User.findById(req.staff.id);
    if (!(await verifyPassword(dto.currentPassword, user.passwordHash))) {
      throw badRequest("Current password is wrong");
    }
    user.passwordHash = await hashPassword(dto.newPassword);
    await user.save();
    await audit({ userId: user._id, action: "PASSWORD_CHANGED", entity: "User", entityId: user._id });
    res.status(204).end();
  })
);

export default router;
