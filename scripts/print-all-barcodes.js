// scripts/print-all-barcodes.js — Generates a master PDF with barcode labels for all active items.
// Usage: node scripts/print-all-barcodes.js [copiesPerItem=1] [outputFile=all-products-barcodes.pdf]
import dotenv from "dotenv";
import { existsSync, writeFileSync } from "fs";
import mongoose from "mongoose";

dotenv.config({ path: existsSync(".env.development") ? ".env.development" : ".env" });

const { Variant } = await import("../inventory/models/Catalog.js");
const { productLabels } = await import("../inventory/services/labels.js");

const copies = Math.max(1, parseInt(process.argv[2], 10) || 1);
const outputFile = process.argv[3] || "all-products-barcodes.pdf";

await mongoose.connect(process.env.MONGO_URI);
console.log("Connected to MongoDB:", process.env.MONGO_URI?.split("/").pop()?.split("?")[0]);

try {
  // Find all active variants (excluding raw kit components, since kits expand to their components)
  const variants = await Variant.find({ active: true, kind: { $in: ["STANDARD", "KIT"] } })
    .select("_id code name kind productId")
    .populate("productId", "name status")
    .lean();

  const activeVariants = variants.filter((v) => v.productId && v.productId.status === "ACTIVE");

  if (!activeVariants.length) {
    console.log("⚠️ No active products found to generate labels for.");
    process.exit(0);
  }

  console.log(`Found ${activeVariants.length} active items. Generating ${copies} copy/copies for each...`);

  const requests = activeVariants.map((v) => ({ variantId: v._id, copies }));
  const pdfBuffer = await productLabels(requests);

  writeFileSync(outputFile, pdfBuffer);
  console.log(`\n✅ Successfully generated barcode labels!`);
  console.log(`📄 Saved to: ${outputFile} (${(pdfBuffer.length / 1024).toFixed(1)} KB)`);
  console.log(`Total items included: ${activeVariants.length}`);
} catch (err) {
  console.error("❌ Failed to generate labels:", err.message);
} finally {
  await mongoose.disconnect();
}

