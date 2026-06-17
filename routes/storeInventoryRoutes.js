// routes/storeInventoryRoutes.js
import express from "express";
import StoreInventory from "../models/StoreInventory.js";
import Product from "../models/Product.js";
import ExcelJS from "exceljs";

const router = express.Router();

// ─── GET /api/admin/store-inventory ───
// Fetch all store inventory records with product details
router.get("/", async (req, res) => {
  try {
    const { q, page = 1, limit = 10, tab, hideEmpty } = req.query;

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

    if (tab && tab !== 'master' && hideEmpty === 'true') {
      filtered = filtered.filter(r => (r.locations?.[tab] || 0) > 0);
    }

    const pageNum = parseInt(page) || 1;
    const limitNum = parseInt(limit) || 10;
    const total = filtered.length;
    const paginated = filtered.slice((pageNum - 1) * limitNum, pageNum * limitNum);

    res.json({
      records: paginated,
      total,
      page: pageNum,
      totalPages: Math.ceil(total / limitNum)
    });
  } catch (err) {
    console.error("Store inventory fetch error:", err);
    res
      .status(500)
      .json({ message: "Failed to fetch store inventory", error: err.message });
  }
});

// ─── GET /api/admin/store-inventory/export ───
router.get("/export", async (req, res) => {
  try {
    const { q, tab, hideEmpty } = req.query;
    
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

    if (tab && tab !== 'master' && hideEmpty === 'true') {
      filtered = filtered.filter(r => (r.locations?.[tab] || 0) > 0);
    }

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Inventory");

    if (tab === "master") {
      worksheet.columns = [
        { header: "Product Name", key: "name", width: 40 },
        { header: "Variant", key: "variant", width: 20 },
        { header: "Downstairs Qty", key: "downstairs", width: 15 },
        { header: "Upstairs Qty", key: "upstairs", width: 15 },
        { header: "Store Qty", key: "store", width: 15 },
        { header: "Garage Qty", key: "garage", width: 15 },
        { header: "Total Qty", key: "total", width: 15 }
      ];

      filtered.forEach(r => {
        const total = ["downstairs", "upstairs", "store", "garage"].reduce((s, l) => s + (r.locations?.[l] || 0), 0);
        worksheet.addRow({
          name: r.product?.name || "Unknown",
          variant: r.variant === "default" ? "Standard" : r.variant,
          downstairs: r.locations?.downstairs || 0,
          upstairs: r.locations?.upstairs || 0,
          store: r.locations?.store || 0,
          garage: r.locations?.garage || 0,
          total: total
        });
      });
    } else {
      const tabName = tab.charAt(0).toUpperCase() + tab.slice(1);
      worksheet.columns = [
        { header: "Product Name", key: "name", width: 40 },
        { header: "Variant", key: "variant", width: 20 },
        { header: `${tabName} Qty`, key: "qty", width: 15 }
      ];

      filtered.forEach(r => {
        worksheet.addRow({
          name: r.product?.name || "Unknown",
          variant: r.variant === "default" ? "Standard" : r.variant,
          qty: r.locations?.[tab] || 0
        });
      });
    }

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename=Inventory_${tab}_${new Date().toISOString().split('T')[0]}.xlsx`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("Export error:", err);
    res.status(500).json({ success: false, message: "Export failed" });
  }
});

// ─── GET /api/admin/store-inventory/master-sheet ───
// Aggregated view: total qty per product/variant across all locations
router.get("/master-sheet", async (req, res) => {
  try {
    const { q, page = 1, limit = 10 } = req.query;

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

    const pageNum = parseInt(page) || 1;
    const limitNum = parseInt(limit) || 10;
    const total = masterData.length;
    const paginated = masterData.slice((pageNum - 1) * limitNum, pageNum * limitNum);

    res.json({
      records: paginated,
      total,
      page: pageNum,
      totalPages: Math.ceil(total / limitNum)
    });
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
          const variantLabel = [v.color, v.dimensions].filter(Boolean).join(" - ") || v._id.toString();
          
          // Prefer matching by variantId since variant labels can change
          let exists = await StoreInventory.findOne({
            product: prod._id,
            variantId: v._id.toString(),
          });
          
          // Fallback to name if variantId wasn't previously populated
          if (!exists) {
            exists = await StoreInventory.findOne({
              product: prod._id,
              variant: variantLabel,
            });
          }
          
          if (!exists) {
            await StoreInventory.create({
              product: prod._id,
              variant: variantLabel,
              variantId: v._id.toString(),
              locations: { downstairs: 0, upstairs: 0, store: 0, garage: 0 },
            });
            created++;
          } else {
            // Update the label just in case it was updated in Product
            if (exists.variant !== variantLabel) {
              exists.variant = variantLabel;
              await exists.save();
            }
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
