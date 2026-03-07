// Run this ONCE to create a dev admin account in twayba_dev database
// Usage: node scripts/createDevAdmin.js
// Then delete or don't commit this file

import mongoose from "mongoose";
import dotenv from "dotenv";
import { existsSync } from "fs";

dotenv.config({ path: existsSync(".env.development") ? ".env.development" : ".env" });

const AdminSchema = new mongoose.Schema({
    username: String,
    email: { type: String, unique: true },
    password: String,
    role: { type: String, default: "admin" },
}, { timestamps: true });

import bcrypt from "bcryptjs";
AdminSchema.pre("save", async function () {
    if (this.isModified("password")) {
        this.password = await bcrypt.hash(this.password, 10);
    }
});

const Admin = mongoose.model("Admin", AdminSchema);

await mongoose.connect(process.env.MONGO_URI);
console.log("Connected to:", process.env.MONGO_URI?.split("/").pop()?.split("?")[0]);

try {
    const admin = new Admin({
        username: "DevAdmin",
        email: "admin@dev.com",
        password: "admin123",
    });
    await admin.save();
    console.log("✅ Dev admin created!");
    console.log("   Email:    admin@dev.com");
    console.log("   Password: admin123");
} catch (err) {
    if (err.code === 11000) {
        console.log("ℹ️  Admin already exists with that email.");
    } else {
        console.error("❌ Error:", err.message);
    }
}

await mongoose.disconnect();
