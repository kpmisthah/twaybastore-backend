import mongoose from "mongoose";
import ExcelJS from "exceljs";
import Product from "./models/Product.js";
import dotenv from "dotenv";
dotenv.config();

function normalize(str) {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to MongoDB.");

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile("../Twayba_Admin-master/[twayba-discount-store]-[2026-06-10]-[16_44].xlsx");
  const worksheet = workbook.worksheets[0];

  let matched = 0;
  let unmatched = [];

  const products = await Product.find({ isDeleted: { $ne: true } });

  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // skip header
    const woltId = row.getCell(1).value?.toString()?.trim();
    const woltName = row.getCell(2).value?.toString()?.trim();

    if (!woltId || !woltName) return;

    let found = false;
    let bestMatch = null;
    let bestScore = 0;

    for (let prod of products) {
      if (prod.woltId === woltId) {
        found = true;
        break;
      }
      if (prod.variants && prod.variants.some(v => v.woltId === woltId)) {
        found = true;
        break;
      }

      const pNorm = normalize(prod.name);
      const wNorm = normalize(woltName);

      if (pNorm === wNorm || wNorm.includes(pNorm) || pNorm.includes(wNorm)) {
        if (!prod.variants || prod.variants.length === 0) {
          prod.woltId = woltId;
          prod.markModified('woltId');
          found = true;
          break;
        } else {
           // Find best variant
           for (let v of prod.variants) {
             const vName = normalize(`${prod.name} ${v.color || ""} ${v.dimensions || ""}`);
             if (vName === wNorm || wNorm.includes(vName) || vName.includes(wNorm)) {
               v.woltId = woltId;
               prod.markModified('variants');
               found = true;
               break;
             }
           }
        }
      }
      if (found) break;
    }

    if (found) {
      matched++;
    } else {
      unmatched.push(woltName);
    }
  });

  for (let prod of products) {
    if (prod.isModified()) {
      await prod.save();
    }
  }

  console.log(`Matched (including exact): ${matched} items. Unmatched: ${unmatched.length}`);
  process.exit();
}

run().catch(console.error);
