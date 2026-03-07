// scripts/checkDevAdmin.js
import mongoose from "mongoose";
import dotenv from "dotenv";
import { existsSync } from "fs";
import bcrypt from "bcryptjs";

dotenv.config({ path: existsSync(".env.development") ? ".env.development" : ".env" });

const AdminSchema = new mongoose.Schema({
    email: String,
    password: { type: String, select: true }
}, { strict: false });

const Admin = mongoose.model("Admin_Check", AdminSchema, "admins");

async function check() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log("Connected to:", process.env.MONGO_URI?.split("/").pop()?.split("?")[0]);

        const admin = await Admin.findOne({ email: "admin@dev.com" }).select("+password");
        if (admin) {
            console.log("✅ User found:", admin.email);
            console.log("   Password Hash starts with:", admin.password?.substring(0, 10), "...");

            const isMatch = await bcrypt.compare("admin123", admin.password);
            console.log("   Password 'admin123' check:", isMatch ? "MATCH ✅" : "NO MATCH ❌");
        } else {
            console.log("❌ User NOT found");
        }
    } catch (err) {
        console.error("❌ Error:", err.message);
    } finally {
        await mongoose.disconnect();
    }
}

check();
