import mongoose from "mongoose";
import ExcelJS from "exceljs";
import Product from "./models/Product.js";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const workbookIn = new ExcelJS.Workbook();
  await workbookIn.xlsx.readFile("../Twayba_Admin-master/[twayba-discount-store]-[2026-06-10]-[16_44].xlsx");
  const worksheetIn = workbookIn.worksheets[0];

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
  worksheetIn.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; 
    const woltId = row.getCell(1).value?.toString()?.trim();
    const woltName = row.getCell(2).value?.toString()?.trim();

    if (!woltId || !woltName) return;

    if (!mappedWoltIds.has(woltId)) {
      unmappedWolt.push({ woltId, woltName });
    }
  });

  let unmappedDB = dbVariants.filter(v => !v.woltId);

  // Write to CSV
  let csv = "WOLT_ID,WOLT_NAME\n";
  for (let u of unmappedWolt) {
    csv += `"${u.woltId}","${u.woltName.replace(/"/g, '""')}"\n`;
  }
  
  fs.writeFileSync("../Twayba_Admin-master/Unmapped_Wolt_Products.csv", csv);

  let csv2 = "DATABASE_NAME\n";
  for (let u of unmappedDB) {
    csv2 += `"${u.name.replace(/"/g, '""')}"\n`;
  }

  fs.writeFileSync("../Twayba_Admin-master/Unmapped_Website_Products.csv", csv2);

  console.log("Saved to CSV");
  process.exit();
}

run().catch(console.error);
