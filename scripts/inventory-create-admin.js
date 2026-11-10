// Creates the first inventory admin (staff login for the inventory app) if none exists.
// Usage: node scripts/inventory-create-admin.js <email> <password> [name]
// Uses .env.development when present (local), otherwise .env.
import dotenv from "dotenv";
import { existsSync } from "fs";
import mongoose from "mongoose";

dotenv.config({ path: existsSync(".env.development") ? ".env.development" : ".env" });

const { hashPassword } = await import("../inventory/lib/password.js");
const { default: User } = await import("../inventory/models/User.js");
const { audit } = await import("../inventory/services/audit.js");

const [email, password, name = "Administrator"] = process.argv.slice(2);
if (!email || !password) {
  console.error("Usage: node scripts/inventory-create-admin.js <email> <password> [name]");
  process.exit(1);
}
if (password.length < 8) {
  console.error("Password must be at least 8 characters");
  process.exit(1);
}

await mongoose.connect(process.env.MONGO_URI);
console.log("Connected to:", process.env.MONGO_URI?.split("/").pop()?.split("?")[0]);

try {
  let user = await User.findOne({ email: email.toLowerCase() });
  if (user) {
    user.passwordHash = await hashPassword(password);
    user.role = "ADMIN";
    user.active = true;
    await user.save();
    console.log(`✅ Existing user '${email}' updated to ADMIN with new password.`);
  } else {
    await User.syncIndexes();
    user = await User.create({
      name,
      email: email.toLowerCase(),
      role: "ADMIN",
      passwordHash: await hashPassword(password),
      active: true,
    });
    await audit({ action: "USER_CREATED", entity: "User", entityId: user._id, data: { name, email, role: "ADMIN", via: "script" } });
    console.log(`✅ New Inventory admin created: ${email}`);
  }

  console.log("\n--- Active Inventory Users ---");
  const allUsers = await User.find().select("name email role active").lean();
  for (const u of allUsers) {
    console.log(`• ${u.name} (${u.email}) - Role: ${u.role} - Active: ${u.active}`);
  }
} finally {
  await mongoose.disconnect();
}
