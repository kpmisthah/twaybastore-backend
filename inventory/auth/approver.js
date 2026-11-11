// inventory/auth/approver.js — an admin/manager types their own login on someone else's device to approve an override.
import { forbidden } from "../lib/http.js";
import { normalizePhone, verifyPassword } from "../lib/password.js";
import User from "../models/User.js";
import { APPROVER_ROLES } from "./roles.js";

/** approval: { login, password }. Returns the approver's id, or throws 403. */
export async function verifyApprover(approval) {
  const login = approval.login.trim();
  const approver = await User.findOne({ $or: [{ email: login.toLowerCase() }, { phone: normalizePhone(login) }] }).lean();
  const ok = !!approver && approver.active && (await verifyPassword(approval.password, approver.passwordHash));
  if (!approver || !ok || !APPROVER_ROLES.includes(approver.role)) {
    throw forbidden("Approval failed — an active admin or manager must enter their own login");
  }
  return String(approver._id);
}
