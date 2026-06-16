// routes/storeInventoryRoutes.js
import express from "express";
import StoreInventory from "../models/StoreInventory.js";
import Product from "../models/Product.js";

const router = express.Router();

// ─── GET /api/admin/store-inventory ───
// Fetch all store inventory records with product details
router.get("/", async (req, res) => {
  try {
    const { q } = req.query;

    const records = await StoreInventory.find()
      .populate("product", "name images variants category productCode")
      .sort({ createdAt: -1 })
      .lean();

    // Filter out records whose product was deleted
    let filtered = records.filter((r) => r.product);

    // Optional search by product name
    if (q) {
      const searchLower = q.toLowerCase();
      filtered = filtered.filter(
        (r) =>
          r.product.name?.toLowerCase().includes(searchLower) ||
          r.variant?.toLowerCase().includes(searchLower)
      );
    }

    res.json({ records: filtered });
  } catch (err) {
    console.error("Store inventory fetch error:", err);
    res
      .status(500)
      .json({ message: "Failed to fetch store inventory", error: err.message });
  }
});

// ─── GET /api/admin/store-inventory/master-sheet ───
// Aggregated view: total qty per product/variant across all locations
router.get("/master-sheet", async (req, res) => {
  try {
    const { q } = req.query;

    const records = await StoreInventory.find()
      .populate("product", "name images variants category productCode")
      .sort({ createdAt: -1 })
      .lean();

    let filtered = records.filter((r) => r.product);

    if (q) {
      const searchLower = q.toLowerCase();
      filtered = filtered.filter(
        (r) =>
          r.product.name?.toLowerCase().includes(searchLower) ||
          r.variant?.toLowerCase().includes(searchLower)
      );
    }

    // Add computed totals
    const masterData = filtered.map((r) => ({
      _id: r._id,
      product: r.product,
      variant: r.variant,
      variantId: r.variantId,
      locations: r.locations,
      total:
        (r.locations.downstairs || 0) +
        (r.locations.upstairs || 0) +
        (r.locations.store || 0) +
        (r.locations.garage || 0),
    }));

    res.json({ records: masterData });
  } catch (err) {
    console.error("Master sheet error:", err);
    res
      .status(500)
      .json({ message: "Failed to fetch master sheet", error: err.message });
  }
});

// ─── PUT /api/admin/store-inventory/:id ───
// Update quantities for a specific inventory record
router.put("/:id", async (req, res) => {
  try {
    const { locations } = req.body;

    if (!locations) {
      return res.status(400).json({ message: "Locations data is required" });
    }

    // Validate non-negative
    for (const [key, val] of Object.entries(locations)) {
      if (typeof val === "number" && val < 0) {
        return res
          .status(400)
          .json({ message: `Quantity for ${key} cannot be negative` });
      }
    }

    const record = await StoreInventory.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          "locations.downstairs": locations.downstairs ?? 0,
          "locations.upstairs": locations.upstairs ?? 0,
          "locations.store": locations.store ?? 0,
          "locations.garage": locations.garage ?? 0,
        },
      },
      { new: true, runValidators: true }
    ).populate("product", "name images variants category productCode");

    if (!record) {
      return res.status(404).json({ message: "Inventory record not found" });
    }

    res.json({ message: "Inventory updated", record });
  } catch (err) {
    console.error("Store inventory update error:", err);
    res
      .status(500)
      .json({ message: "Failed to update inventory", error: err.message });
  }
});

// ─── POST /api/admin/store-inventory/bulk-init ───
// Auto-create inventory records for all products/variants that don't have one yet
router.post("/bulk-init", async (req, res) => {
  try {
    const products = await Product.find({ isDeleted: { $ne: true } }).lean();
    let created = 0;
    let skipped = 0;

    for (const prod of products) {
      if (prod.variants && prod.variants.length > 0) {
        // Create one record per variant
        for (const v of prod.variants) {
          const variantLabel = v.color || v.size || v._id.toString();
          const exists = await StoreInventory.findOne({
            product: prod._id,
            variant: variantLabel,
          });
          if (!exists) {
            await StoreInventory.create({
              product: prod._id,
              variant: variantLabel,
              variantId: v._id.toString(),
              locations: { downstairs: 0, upstairs: 0, store: 0, garage: 0 },
            });
            created++;
          } else {
            skipped++;
          }
        }
      } else {
        // Single product without variants
        const exists = await StoreInventory.findOne({
          product: prod._id,
          variant: "default",
        });
        if (!exists) {
          await StoreInventory.create({
            product: prod._id,
            variant: "default",
            variantId: null,
            locations: { downstairs: 0, upstairs: 0, store: 0, garage: 0 },
          });
          created++;
        } else {
          skipped++;
        }
      }
    }

    res.json({
      message: `Initialization complete. Created: ${created}, Skipped (already exist): ${skipped}`,
      created,
      skipped,
    });
  } catch (err) {
    console.error("Bulk init error:", err);
    res
      .status(500)
      .json({ message: "Failed to initialize inventory", error: err.message });
  }
});

// ─── DELETE /api/admin/store-inventory/:id ───
// Delete a specific inventory record
router.delete("/:id", async (req, res) => {
  try {
    const record = await StoreInventory.findByIdAndDelete(req.params.id);
    if (!record) {
      return res.status(404).json({ message: "Inventory record not found" });
    }
    res.json({ message: "Inventory record deleted" });
  } catch (err) {
    console.error("Store inventory delete error:", err);
    res
      .status(500)
      .json({ message: "Failed to delete record", error: err.message });
  }
});

export default router;
