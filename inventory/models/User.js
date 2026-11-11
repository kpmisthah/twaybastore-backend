// inventory/models/User.js — staff accounts (separate from website customers and the website admin).
import { model, ObjectId, Schema, uniqueWhenSet } from "./_base.js";

export const ROLES = ["ADMIN", "MANAGER", "WAREHOUSE", "CASHIER", "DRIVER", "VIEWER"];

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, lowercase: true, trim: true, default: undefined },
    phone: { type: String, trim: true, default: undefined },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ROLES, required: true },
    /** Sites (top-level locations) this user may change stock in. Empty = all sites. Ignored for admins/managers. */
    siteIds: { type: [ObjectId], default: [] },
    active: { type: Boolean, default: true },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true }
);

uniqueWhenSet(userSchema, "email");
uniqueWhenSet(userSchema, "phone");

/** Fields safe to return to clients — never includes passwordHash. */
export const PUBLIC_USER_FIELDS = "name email phone role siteIds active lastLoginAt createdAt updatedAt";

export default model("InvUser", userSchema, "inv_users");
