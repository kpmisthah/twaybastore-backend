import mongoose from "mongoose";
import ExcelJS from "exceljs";
import Product from "./models/Product.js";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile("../Twayba_Admin-master/[twayba-discount-store]-[2026-06-10]-[16_44].xlsx");
  const worksheet = workbook.worksheets[0];

  const products = await Product.find({ isDeleted: { $ne: true } });

  let dbVariants = [];
  for (let prod of products) {
    if (!prod.variants || prod.variants.length === 0) {
      dbVariants.push({
        id: prod._id,
        name: prod.name.trim(),
        woltId: prod.woltId
      });
    } else {
      for (let v of prod.variants) {
        dbVariants.push({
          id: v._id,
          name: `${prod.name} ${v.color || ""} ${v.dimensions || ""}`.trim(),
          woltId: v.woltId
        });
      }
    }
  }

  let mappedWoltIds = new Set();
  for (let dbv of dbVariants) {
    if (dbv.woltId) {
      mappedWoltIds.add(dbv.woltId);
    }
  }

  let unmappedWolt = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; 
    const woltId = row.getCell(1).value?.toString()?.trim();
    const woltName = row.getCell(2).value?.toString()?.trim();

    if (!woltId || !woltName) return;

    if (!mappedWoltIds.has(woltId)) {
      unmappedWolt.push({ woltId, woltName });
    }
  });

  let unmappedDB = dbVariants.filter(v => !v.woltId);

  let md = `# Unmapped Products\n\n`;
  md += `There are ${unmappedWolt.length} Wolt products that could not be mapped to the database.\n\n`;
  
  md += `## Unmapped Wolt Products (From your Excel Sheet)\n\n`;
  md += `| Wolt Name | Wolt ID |\n`;
  md += `|---|---|\n`;
  for (let u of unmappedWolt) {
    md += `| ${u.woltName} | ${u.woltId} |\n`;
  }

  md += `\n## Unmapped Database Products (From your Website)\n\n`;
  md += `| Database Name |\n`;
  md += `|---|\n`;
  for (let u of unmappedDB) {
    md += `| ${u.name} |\n`;
  }

  fs.writeFileSync("/home/misthah/.gemini/antigravity/brain/39949029-7753-475a-b6b4-8e29fe6e0e39/unmapped_products.md", md);

  console.log("Generated unmapped_products.md");
  process.exit();
}

run().catch(console.error);
