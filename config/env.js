// config/env.js
// This MUST be the first import in server.js so env vars are loaded
// before any other module (like stripe.js) reads from process.env
import dotenv from "dotenv";
import { existsSync } from "fs";

// Use .env.development if it exists (localhost), otherwise .env (production)
const envFile = existsSync(".env.development") ? ".env.development" : ".env";
dotenv.config({ path: envFile });

console.log(`🔧 Loaded env from: ${envFile}`);
