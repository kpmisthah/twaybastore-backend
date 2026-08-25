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

  let out = "--- UNMAPPED WOLT ITEMS ---\n";
  for(let w of unmappedWolt) out += `${w.woltId} | ${w.woltName}\n`;
  out += "\n--- UNMAPPED DATABASE ITEMS ---\n";
  for(let d of unmappedDB) out += `${d.id} | ${d.name}\n`;

  fs.writeFileSync("unmapped.txt", out);
  console.log("Written to unmapped.txt");
  process.exit();
}

run().catch(console.error);
