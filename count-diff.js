import mongoose from "mongoose";
import ExcelJS from "exceljs";
import Product from "./models/Product.js";
import dotenv from "dotenv";

dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  
  const workbookIn = new ExcelJS.Workbook();
  await workbookIn.xlsx.readFile("../Twayba_Admin-master/[twayba-discount-store]-[2026-06-10]-[16_44].xlsx");
  const worksheetIn = workbookIn.worksheets[0];

  let originalWoltIds = new Set();
  let rowCount = 0;
  worksheetIn.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const woltId = row.getCell(1).value?.toString()?.trim();
    if (woltId) {
      originalWoltIds.add(woltId);
      rowCount++;
    }
  });
  console.log("Original spreadsheet rows with Wolt ID:", rowCount);
  console.log("Original unique Wolt IDs:", originalWoltIds.size);

  const products = await Product.find({ isDeleted: { $ne: true } });
  let exportedWoltIds = new Set();
  
  for (let prod of products) {
    if (prod.variants && prod.variants.length > 0) {
      for (let v of prod.variants) {
        if (v.woltId) exportedWoltIds.add(v.woltId);
      }
    } else {
      if (prod.woltId) exportedWoltIds.add(prod.woltId);
    }
  }

  console.log("Total unique Wolt IDs currently mapped in DB:", exportedWoltIds.size);

  let missing = [];
  for (let id of originalWoltIds) {
    if (!exportedWoltIds.has(id)) {
      missing.push(id);
    }
  }

  console.log("Missing IDs not mapped in DB:", missing.length);
  for (let m of missing) {
     let name = "";
     worksheetIn.eachRow((row) => {
        if (row.getCell(1).value?.toString()?.trim() === m) {
           name = row.getCell(2).value?.toString();
        }
     });
     console.log(`Missing mapping: ${m} - ${name}`);
  }

  process.exit();
}
run().catch(console.error);
