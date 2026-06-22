// routes/storeInventoryRoutes.js
import express from "express";
import StoreInventory from "../models/StoreInventory.js";
import Product from "../models/Product.js";
import ExcelJS from "exceljs";
import InventoryLog from "../models/InventoryLog.js";
import Order from "../models/Order.js";
import { getMaltaBusinessDate } from "../utils/businessDate.js";

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

// ─── POST /api/admin/store-inventory/action ───
// Handle strict inventory movements (Add, Move, Sell, Adjust)
router.post("/action", async (req, res) => {
  try {
    const {
      productId,
      variantId, // optional
      actionType, // 'add_stock', 'move', 'sale', 'adjustment'
      fromLocation,
      toLocation,
      quantity,
      channel, // 'wolt', 'shop'
      price // optional, for sale
    } = req.body;

    const qty = parseInt(quantity);
    if (!qty || qty <= 0) return res.status(400).json({ message: "Quantity must be greater than zero." });

    const product = await Product.findById(productId);
    if (!product) return res.status(404).json({ message: "Product not found." });

    // Find StoreInventory record
    let inventoryQuery = { product: productId };
    if (variantId) {
      inventoryQuery.variantId = variantId;
    } else {
      inventoryQuery.variant = "default"; // or handle missing variant
    }

    // It's possible there are multiple matches if legacy, but let's grab the first
    let storeRecord = await StoreInventory.findOne(inventoryQuery);
    if (!storeRecord && !variantId && product.variants?.length > 0) {
      // Fallback: if variantId not passed but product has variants, we can't do this reliably
      return res.status(400).json({ message: "Please specify a variant for this product." });
    }
    
    if (!storeRecord) {
      // Create it if it doesn't exist
      storeRecord = await StoreInventory.create({
        product: productId,
        variantId: variantId || null,
        variant: variantId ? product.variants.find(v => v._id.toString() === variantId)?.color + " - " + product.variants.find(v => v._id.toString() === variantId)?.dimensions : "default",
        locations: { downstairs: 0, upstairs: 0, store: 0, garage: 0 }
      });
    }

    // Handle Actions
    if (actionType === "add_stock") {
      if (!toLocation) return res.status(400).json({ message: "Destination location required." });
      storeRecord.locations[toLocation] += qty;
      
      // TEMPORARILY DISABLED: Update global stock
      // The user requested to disable global stock updates during the initial store location sync.
      // Uncomment the below code once the initial sync is complete.
      /*
      if (variantId) {
        const v = product.variants.find(v => v._id.toString() === variantId);
        if (v) v.stock = (v.stock || 0) + qty;
      } else {
        product.stock = (product.stock || 0) + qty;
      }
      */

    } else if (actionType === "move") {
      if (!fromLocation || !toLocation) return res.status(400).json({ message: "Source and destination required." });
      if (storeRecord.locations[fromLocation] < qty) return res.status(400).json({ message: `Not enough stock in ${fromLocation}.` });
      
      storeRecord.locations[fromLocation] -= qty;
      storeRecord.locations[toLocation] += qty;
      // Global stock unchanged

    } else if (actionType === "adjustment") {
      if (!fromLocation) return res.status(400).json({ message: "Source location required." });
      if (storeRecord.locations[fromLocation] < qty) return res.status(400).json({ message: `Not enough stock in ${fromLocation}.` });
      
      storeRecord.locations[fromLocation] -= qty;
      
      if (variantId) {
        const v = product.variants.find(v => v._id.toString() === variantId);
        if (v) v.stock = Math.max(0, (v.stock || 0) - qty);
      } else {
        product.stock = Math.max(0, (product.stock || 0) - qty);
      }

    } else if (actionType === "sale") {
      if (!fromLocation) return res.status(400).json({ message: "Source location required." });
      if (!channel) return res.status(400).json({ message: "Channel (Wolt/Shop) required." });
      if (storeRecord.locations[fromLocation] < qty) return res.status(400).json({ message: `Not enough stock in ${fromLocation}.` });
      
      storeRecord.locations[fromLocation] -= qty;
      
      let itemPrice = parseFloat(price);
      if (isNaN(itemPrice)) {
        if (variantId) {
          const v = product.variants.find(v => v._id.toString() === variantId);
          itemPrice = v?.price || product.price;
        } else {
          itemPrice = product.price;
        }
      }

      // Deduct global stock
      if (variantId) {
        const v = product.variants.find(v => v._id.toString() === variantId);
        if (v) v.stock = Math.max(0, (v.stock || 0) - qty);
      } else {
        product.stock = Math.max(0, (product.stock || 0) - qty);
      }

      // Create Sales Record via Order
      const businessDate = getMaltaBusinessDate();
      
      const vDetails = variantId ? product.variants.find(v => v._id.toString() === variantId) : null;

      await Order.create({
        user: null, // guest/pos
        items: [{
          name: product.name,
          price: itemPrice,
          qty: qty,
          image: product.images?.[0] || "",
          product: product._id,
          color: vDetails?.color || "",
          dimensions: vDetails?.dimensions || "",
          fulfilledLocations: [{ location: fromLocation, quantity: qty }]
        }],
        total: itemPrice * qty,
        finalTotal: itemPrice * qty,
        discountAmount: 0,
        paymentMethod: "CASH", // Or POS, assuming paid
        isPaid: true,
        paidAt: new Date(),
        status: "Delivered", // Auto fulfilled
        channel: channel, // wolt or shop
        businessDate: businessDate
      });
    } else {
      return res.status(400).json({ message: "Invalid action type." });
    }

    // Save logs and updates
    await storeRecord.save();
    await product.save();

    await InventoryLog.create({
      product: productId,
      variantId,
      actionType,
      fromLocation,
      toLocation,
      quantity: qty,
      channel,
      price: parseFloat(price) || undefined,
      businessDate: getMaltaBusinessDate()
    });

    res.json({ message: "Inventory action completed successfully.", record: storeRecord });
  } catch (err) {
    console.error("Inventory action error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
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
