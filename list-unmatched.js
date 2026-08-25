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
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile("../Twayba_Admin-master/[twayba-discount-store]-[2026-06-10]-[16_44].xlsx");
  const worksheet = workbook.worksheets[0];

  let unmatched = [];
  const products = await Product.find({ isDeleted: { $ne: true } });

  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // skip header
    const woltId = row.getCell(1).value?.toString()?.trim();
    const woltName = row.getCell(2).value?.toString()?.trim();

    if (!woltId || !woltName) return;

    let found = false;
    for (let prod of products) {
      if (prod.woltId === woltId) {
        found = true;
        break;
      }
      if (prod.variants && prod.variants.some(v => v.woltId === woltId)) {
        found = true;
        break;
      }
    }

    if (!found) {
      unmatched.push(woltName);
    }
  });

  console.log("Some unmatched items:");
  console.log(unmatched.slice(0, 30));
  process.exit();
}

run().catch(console.error);
