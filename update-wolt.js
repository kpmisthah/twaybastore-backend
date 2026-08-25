import mongoose from "mongoose";
import ExcelJS from "exceljs";
import Product from "./models/Product.js";
import dotenv from "dotenv";
dotenv.config();

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

    // Exact match
    for (let prod of products) {
      if (prod.name.trim().toLowerCase() === woltName.toLowerCase()) {
        prod.woltId = woltId;
        prod.markModified('woltId');
        found = true;
        break;
      }
      
      if (prod.variants && prod.variants.length > 0) {
        for (let v of prod.variants) {
          const vName = `${prod.name} ${v.color || ""} ${v.dimensions || ""}`.trim().toLowerCase();
          if (vName === woltName.toLowerCase()) {
            v.woltId = woltId;
            prod.markModified('variants');
            found = true;
            break;
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

  console.log(`Matched ${matched} items. Unmatched: ${unmatched.length}`);
  if (unmatched.length > 0) {
    console.log("Some unmatched items:");
    console.log(unmatched.slice(0, 20));
  }
  process.exit();
}

run().catch(console.error);
