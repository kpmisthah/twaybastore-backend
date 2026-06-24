import express from "express";
import Product from "../models/Product.js";
import Order from "../models/Order.js";
import { upload } from "../middleware/upload.js";
// Switched from R2 to Cloudinary (free tier)
import { uploadToCloudinary } from "../utils/uploadToCloudinary.js";
import { removeProductRow } from "../utils/googleSheetsService.js";
import ExcelJS from "exceljs";
const router = express.Router();

/* ---------------------------------------------
   1) AI SEARCH SUGGESTIONS (must be first)
---------------------------------------------- */
router.get("/suggestions", async (req, res) => {
  try {
    const q = req.query.q?.trim();
    if (!q) return res.json({ success: true, suggestions: [] });

    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`\\b${escaped}\\b`, "i");

    const products = await Product.find(
      { name: regex, isDeleted: { $ne: true } },
      { name: 1, images: 1, slug: 1 }
    )
      .limit(6)
      .lean();

    res.json({
      success: true,
      suggestions: products.map((p) => ({
        name: p.name,
        image: p.images?.[0] || null,
        slug: p.slug || p._id,
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

/* ---------------------------------------------
   1.1) EXPORT PRODUCTS TO XLSX
---------------------------------------------- */
router.get("/export", async (req, res) => {
  try {
    const products = await Product.find({ isDeleted: { $ne: true } }).lean();

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Inventory");

    worksheet.columns = [
      { header: "Merchant SKU / GTIN", key: "sku", width: 20 },
      { header: "Item Name", key: "name", width: 40 },
      { header: "Description", key: "description", width: 40 },
      { header: "Category", key: "category", width: 20 },
      { header: "Sub Category", key: "subCategory", width: 20 },
      { header: "Price", key: "price", width: 10 },
      { header: "Stock", key: "stock", width: 10 },
      { header: "Image URL", key: "image", width: 50 },
    ];

    products.forEach((prod) => {
      if (prod.variants && prod.variants.length > 0) {
        prod.variants.forEach((variant) => {
          // Construct name with variant details: e.g. "T-Shirt Red M"
          const variantName = `${prod.name} ${variant.color || ""} ${variant.dimensions || ""}`.trim();

          worksheet.addRow({
            sku: prod.sku || prod.productCode || "",
            name: variantName,
            description: prod.description,
            category: prod.category,
            subCategory: prod.subCategory || "",
            price: variant.price || prod.price,
            stock: variant.stock || 0,
            image: (variant.images && variant.images[0]) || (prod.images && prod.images[0]) || "",
          });
        });
      } else {
        worksheet.addRow({
          sku: prod.sku || prod.productCode || "",
          name: prod.name,
          description: prod.description,
          category: prod.category,
          subCategory: prod.subCategory || "",
          price: prod.price,
          stock: prod.stock || 0,
          image: prod.images?.[0] || "",
        });
      }
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=inventory.xlsx"
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("Export failed:", err);
    res.status(500).json({ message: "Export failed" });
  }
});

/* ---------------------------------------------
   1.2) EXPORT PRODUCTS TO XLSX (WOLT)
---------------------------------------------- */
router.get("/export-wolt", async (req, res) => {
  try {
    const products = await Product.find({ isDeleted: { $ne: true } }).lean();

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Wolt Inventory");

    worksheet.columns = [
      { header: "id", key: "id", width: 30 },
      { header: "name", key: "name", width: 50 },
      { header: "total", key: "total", width: 15 },
    ];

    products.forEach((prod) => {
      if (prod.variants && prod.variants.length > 0) {
        prod.variants.forEach((variant) => {
          const variantName = `${prod.name} ${variant.color || ""} ${variant.dimensions || ""}`.trim();
          worksheet.addRow({
            id: variant._id.toString(),
            name: variantName,
            total: variant.stock || 0,
          });
        });
      } else {
        worksheet.addRow({
          id: prod._id.toString(),
          name: prod.name,
          total: prod.stock || 0,
        });
      }
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=wolt_inventory.xlsx"
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("Export Wolt failed:", err);
    res.status(500).json({ message: "Export Wolt failed" });
  }
});

/* ---------------------------------------------
   2) MOST SOLD (must be above :id)
---------------------------------------------- */
router.get("/most-sold", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 12, 50);

    const pipeline = [
      { $unwind: "$items" },
      { $match: { "items.product": { $ne: null } } },
      {
        $group: {
          _id: "$items.product",
          totalSold: { $sum: { $ifNull: ["$items.qty", 1] } },
        },
      },
      { $sort: { totalSold: -1 } },
      { $limit: limit },
      {
        $lookup: {
          from: "products",
          localField: "_id",
          foreignField: "_id",
          as: "product",
        },
      },
      { $unwind: "$product" },
      { $match: { "product.isDeleted": { $ne: true } } },
      {
        $project: {
          _id: 0,
          productId: "$product._id",
          name: "$product.name",
          price: "$product.price",
          realPrice: "$product.realPrice",
          discount: "$product.discount",
          images: "$product.images",
          description: "$product.description",
          totalSold: 1,
        },
      },
    ];

    const results = await Order.aggregate(pipeline);
    res.json(results);
  } catch (err) {
    console.error("most-sold error:", err);
    res.status(500).json({ message: "Failed to fetch most sold products" });
  }
});

/* ---------------------------------------------
   3) CHECK CART (must be above :id)
---------------------------------------------- */
router.post("/check-cart", async (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "No cart items provided" });
    }

    const productIds = items.map((item) => item._id);
    const products = await Product.find({
      _id: { $in: productIds },
      isDeleted: { $ne: true },
    });

    const results = items
      .map((cartItem) => {
        const product = products.find((p) => p._id.toString() === cartItem._id);
        if (!product) return null;

        const variant = product.variants?.find((v) => {
          const colorMatch =
            !cartItem.color ||
            v.color?.toLowerCase() === cartItem.color?.toLowerCase();
          const dimMatch =
            !cartItem.dimensions ||
            v.dimensions?.trim() === cartItem.dimensions?.trim();
          return colorMatch && dimMatch;
        });

        return {
          _id: product._id,
          name: product.name,
          color: cartItem.color || null,
          stock: variant?.stock ?? 0,
          price: variant?.price ?? product.price,
        };
      })
      .filter(Boolean);

    res.json(results);
  } catch (err) {
    console.error("check-cart error:", err);
    res.status(500).json({ message: "Failed to check cart products" });
  }
});

/* ---------------------------------------------
   4) CLICK TRACKER (must be above :id/related)
---------------------------------------------- */
router.patch("/:id/click", async (req, res) => {
  try {
    const product = await Product.findByIdAndUpdate(
      req.params.id,
      { $inc: { clickCount: 1 } },
      { new: true }
    );
    if (!product) return res.status(404).json({ error: "Product not found" });
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: "Failed to update click count" });
  }
});

/* ---------------------------------------------
   5) ADD PRODUCT (WITH R2 IMAGES)
---------------------------------------------- */
import StoreInventory from "../models/StoreInventory.js";

router.post("/", async (req, res) => {
  try {
    let baseStock = 0;
    if (req.body.locations) {
      baseStock = (req.body.locations.downstairs || 0) + (req.body.locations.upstairs || 0) + (req.body.locations.store || 0) + (req.body.locations.garage || 0);
    }

    const product = await Product.create({
      ...req.body,
      realPrice: Number(req.body.realPrice),
      price: Number(req.body.price),
      discount: Number(req.body.discount || 0),
      stock: req.body.variants?.length ? 0 : (req.body.stock || baseStock),
      images: req.body.images, // already URLs
    });

    // Create store inventory records
    if (req.body.variants && req.body.variants.length > 0) {
      for (const v of product.variants) {
        const reqVar = req.body.variants.find(rv => rv.color === v.color && rv.dimensions === v.dimensions);
        await StoreInventory.create({
          product: product._id,
          variant: [v.color, v.dimensions].filter(Boolean).join(" - ") || v._id.toString(),
          variantId: v._id.toString(),
          locations: reqVar?.locations || { downstairs: 0, upstairs: 0, store: 0, garage: 0 }
        });
      }
    } else {
      await StoreInventory.create({
        product: product._id,
        variant: "default",
        variantId: null,
        locations: req.body.locations || { downstairs: 0, upstairs: 0, store: 0, garage: 0 }
      });
    }

    res.json({ success: true, product });
  } catch (err) {
    console.error("Product create error:", err);
    res.status(500).json({ message: "Product create failed" });
  }
});

/* ---------------------------------------------
   6) GET ALL PRODUCTS (WITH PAGINATION & FILTERS)
---------------------------------------------- */
router.get("/", async (req, res) => {
  try {
    const {
      q,              // Search query
      category,       // Filter by category
      minPrice,       // Filter by min price
      maxPrice,       // Filter by max price
      inStock,        // Filter by stock availability (true/false)
      discount,       // Filter by discount (true/false)
      weeklyDeal,     // Filter by weeklyDeal (true/false)
      sort = 'newest', // Sort: newest, price-asc, price-desc, popular, name
      page = 1,       // Page number
      limit = 12      // Items per page
    } = req.query;

    // Build filter object
    let filter = { isDeleted: { $ne: true } };

    // Search by name only
    if (q) {
      const escaped = q.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");
      const regex = new RegExp(escaped, "i");
      filter.name = regex;
    }

    // Filter by category
    if (category) {
      if (category.toLowerCase() === 'discount') {
        filter.isDiscounted = true;
      } else {
        filter.category = category;
      }
    }

    // Filter by price range
    if (minPrice || maxPrice) {
      filter.price = {};
      if (minPrice) filter.price.$gte = Number(minPrice);
      if (maxPrice) filter.price.$lte = Number(maxPrice);
    }

    // Filter by stock availability
    if (inStock === 'true') {
      filter.stock = { $gt: 0 };
    }

    // Filter by discount
    if (discount === 'true') {
      filter.discount = { $gt: 0 };
    }

    // Filter by weeklyDeal
    if (weeklyDeal === 'true') {
      filter.weeklyDeal = true;
    }

    // Build sort option
    let sortOption = { createdAt: -1 }; // Default: newest first
    switch (sort) {
      case 'price-asc':
        sortOption = { price: 1 };
        break;
      case 'price-desc':
        sortOption = { price: -1 };
        break;
      case 'popular':
        sortOption = { clickCount: -1 };
        break;
      case 'name':
        sortOption = { name: 1 };
        break;
      case 'name-desc':
        sortOption = { name: -1 };
        break;
      case 'oldest':
        sortOption = { createdAt: 1 };
        break;
      default:
        sortOption = { createdAt: -1 };
    }

    // Pagination
    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(1200, Math.max(1, parseInt(limit) || 12));
    const skip = (pageNum - 1) * limitNum;

    // Execute query with pagination
    const [products, total] = await Promise.all([
      Product.find(filter)
        .sort(sortOption)
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Product.countDocuments(filter)
    ]);

    // Calculate pagination metadata
    const totalPages = Math.ceil(total / limitNum);
    const hasNextPage = pageNum < totalPages;
    const hasPrevPage = pageNum > 1;

    res.json({
      products,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages,
        hasNextPage,
        hasPrevPage
      }
    });
  } catch (err) {
    console.error("Product fetch failed:", err);
    res.status(500).json({
      message: "Failed to fetch products",
      error: process.env.NODE_ENV !== "production" ? err.message : undefined
    });
  }
});

/* ---------------------------------------------
   7) RELATED PRODUCTS
---------------------------------------------- */
router.get("/:id/related", async (req, res) => {
  try {
    const mainProduct = await Product.findById(req.params.id);
    if (!mainProduct)
      return res.status(404).json({ message: "Product not found" });

    const related = await Product.find({
      _id: { $ne: mainProduct._id },
      category: mainProduct.category,
      isDeleted: { $ne: true },
    }).limit(8);

    res.json(related);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "Failed to load related products" });
  }
});

/* ---------------------------------------------
   8) DECREMENT STOCK
---------------------------------------------- */
router.patch("/:id/decrement-stock", async (req, res) => {
  const { qty, variantColor } = req.body;
  if (!qty || qty < 1) return res.status(400).json({ error: "Invalid qty" });

  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: "Product not found" });

    if (variantColor && product.variants && product.variants.length) {
      const variant = product.variants.find(
        (v) => v.color.toLowerCase() === variantColor.toLowerCase()
      );
      if (!variant) return res.status(404).json({ error: "Variant not found" });
      if (variant.stock < qty)
        return res.status(400).json({ error: "Not enough variant stock" });

      variant.stock -= qty;
    }

    if (product.stock < qty)
      return res.status(400).json({ error: "Not enough total stock" });

    product.stock -= qty;

    await product.save();
    res.json({ success: true, stock: product.stock });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---------------------------------------------
   9) GET SINGLE PRODUCT (must be LAST GET)
---------------------------------------------- */
router.get("/:id", async (req, res) => {
  try {
    const product = await Product.findOne({
      _id: req.params.id,
      isDeleted: { $ne: true },
    }).lean();
    if (!product) return res.status(404).json({ message: "Product not found" });

    // Fetch store inventory to include locations
    const inventory = await StoreInventory.find({ product: product._id }).lean();

    if (inventory && inventory.length > 0) {
      if (!product.variants || product.variants.length === 0) {
        const defaultInv = inventory.find(i => i.variant === "default");
        if (defaultInv) {
          product.locations = defaultInv.locations;
        }
      } else {
        product.variants = product.variants.map(v => {
          const inv = inventory.find(i => i.variantId === v._id.toString());
          return { ...v, locations: inv ? inv.locations : { downstairs: 0, upstairs: 0, store: 0, garage: 0 } };
        });
      }
    } else {
      product.locations = { downstairs: 0, upstairs: 0, store: 0, garage: 0 };
    }

    res.status(200).json(product);
  } catch (err) {
    res.status(500).json({ message: "Error fetching product" });
  }
});

/* ---------------------------------------------
   10) UPDATE PRODUCT
---------------------------------------------- */
router.put("/:id", async (req, res) => {
  try {
    let baseStock = 0;
    if (req.body.locations) {
      baseStock = (req.body.locations.downstairs || 0) + (req.body.locations.upstairs || 0) + (req.body.locations.store || 0) + (req.body.locations.garage || 0);
      req.body.stock = req.body.variants?.length ? 0 : (req.body.stock || baseStock);
    }

    const updated = await Product.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
    });
    if (!updated) return res.status(404).json({ message: "Product not found" });

    // Update store inventory records
    if (req.body.variants && req.body.variants.length > 0) {
      for (const v of updated.variants) {
        const reqVar = req.body.variants.find(rv => rv.color === v.color && rv.dimensions === v.dimensions);
        if (reqVar?.locations) {
          await StoreInventory.findOneAndUpdate(
            { product: updated._id, variantId: v._id.toString() },
            {
              $set: {
                locations: reqVar.locations,
                variant: [v.color, v.dimensions].filter(Boolean).join(" - ") || v._id.toString()
              }
            },
            { upsert: true, new: true }
          );
        }
      }
    } else if (req.body.locations) {
      await StoreInventory.findOneAndUpdate(
        { product: updated._id, variant: "default" },
        { $set: { locations: req.body.locations } },
        { upsert: true, new: true }
      );
    }

    res.status(200).json({ message: "Product updated", product: updated });
  } catch (err) {
    console.error("Error updating product:", err);
    res.status(500).json({ message: "Error updating product" });
  }
});

/* ---------------------------------------------
   11) DELETE PRODUCT
---------------------------------------------- */
router.delete("/:id", async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: "Product not found" });

    // Sync with Google Sheets if productCode exists
    if (product.productCode) {
      await removeProductRow(product.productCode);
    }

    const deleted = await Product.findByIdAndUpdate(
      req.params.id,
      { isDeleted: true, deletedAt: new Date() },
      { new: true }
    );
    res.status(200).json({ message: "Product deleted (soft)" });
  } catch (err) {
    console.error("Delete product error:", err);
    res.status(500).json({ message: "Error deleting product" });
  }
});

export default router;
