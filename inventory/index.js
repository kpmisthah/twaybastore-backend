// inventory/index.js — Twayba Inventory API, mounted at /api/inv.
// Off unless INVENTORY_ENABLED=true, so deploying this code changes nothing until it is switched on.
import express from "express";
import mongoose from "mongoose";
import { requireStaff } from "./auth/auth.js";
import { ah, errorHandler, notFound } from "./lib/http.js";
import auditRoutes from "./routes/audit.js";
import authRoutes from "./routes/auth.js";
import locationRoutes from "./routes/locations.js";
import importRoutes from "./routes/imports.js";
import miscRoutes from "./routes/misc.js";
import productRoutes from "./routes/products.js";
import reportRoutes from "./routes/reports.js";
import settingsRoutes from "./routes/settings.js";
import stockRoutes from "./routes/stock.js";
import { orderRoutes, websiteOrderRoutes } from "./routes/orders.js";
import { returnRoutes, saleRoutes } from "./routes/sales.js";
import { stocktakeRoutes, transferRoutes } from "./routes/transfers.js";
import userRoutes from "./routes/users.js";
import { ensureSystemLocations } from "./services/locations.js";
import { catchUpWebsiteOrders, startWebsiteOrderWatcher } from "./services/websiteOrders.js";
import { startWebsiteWatcher, syncAllFromWebsite } from "./services/websiteSync.js";

export const INVENTORY_BASE = "/api/inv";

export function inventoryEnabled() {
  return process.env.INVENTORY_ENABLED === "true";
}

function buildRouter() {
  const router = express.Router();

  router.get("/health", (req, res) => res.json({ ok: true, db: mongoose.connection.readyState === 1 }));
  router.use("/auth", authRoutes);

  // Everything below needs a logged-in staff member.
  router.use(requireStaff);
  router.use("/users", userRoutes);
  router.use("/audit", auditRoutes);
  router.use("/locations", locationRoutes);
  router.use("/stock", stockRoutes);
  router.use("/transfers", transferRoutes);
  router.use("/stocktakes", stocktakeRoutes);
  router.use("/sales", saleRoutes);
  router.use("/returns", returnRoutes);
  router.use("/orders", orderRoutes);
  router.use("/website-orders", websiteOrderRoutes);
  router.use("/", settingsRoutes);
  router.use("/", productRoutes);
  router.use("/", miscRoutes);
  // After misc.js, which answers GET /reports/options.
  router.use("/reports", reportRoutes);
  router.use("/imports", importRoutes);

  router.use(
    ah(async () => {
      throw notFound("No such inventory endpoint");
    })
  );
  router.use(errorHandler);
  return router;
}

/** Mounts the API and, once MongoDB is connected, prepares system data and starts the website sync. */
export function mountInventory(app) {
  app.use(INVENTORY_BASE, buildRouter());

  const startup = async () => {
    try {
      await ensureSystemLocations();
      if (process.env.INVENTORY_WEBSITE_SYNC !== "false") {
        startWebsiteWatcher();
        const result = await syncAllFromWebsite();
        console.log(
          `📦 Inventory: website products synced — ${result.created} new, ${result.updated} updated, ${result.unchanged} unchanged` +
            (result.failed ? `, ${result.failed} failed` : "")
        );
      }
      // Website orders placed from now on become delivery orders (older ones are left alone).
      if (process.env.INVENTORY_WEBSITE_ORDERS !== "false") {
        await startWebsiteOrderWatcher();
        const orders = await catchUpWebsiteOrders();
        if (orders.imported || orders.problem) {
          console.log(`📦 Inventory: website orders — ${orders.imported} imported, ${orders.problem} need attention`);
        }
      }
    } catch (e) {
      console.error("📦 Inventory startup error:", e);
    }
  };
  if (mongoose.connection.readyState === 1) startup();
  else mongoose.connection.once("connected", startup);

  console.log(`📦 Inventory API enabled at ${INVENTORY_BASE}`);
}
