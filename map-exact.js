import mongoose from "mongoose";
import ExcelJS from "exceljs";
import Product from "./models/Product.js";
import dotenv from "dotenv";
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
        name: prod.name.trim().toLowerCase(),
        isVariant: false,
        prodObj: prod,
        woltId: prod.woltId
      });
    } else {
      for (let v of prod.variants) {
        dbVariants.push({
          id: v._id,
          name: `${prod.name} ${v.color || ""} ${v.dimensions || ""}`.trim().toLowerCase(),
          isVariant: true,
          prodObj: prod,
          vObj: v,
          woltId: v.woltId
        });
      }
    }
  }

  let mappedCount = 0;
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; 
    const woltId = row.getCell(1).value?.toString()?.trim();
    const woltName = row.getCell(2).value?.toString()?.trim()?.toLowerCase();

    if (!woltId || !woltName) return;

    let bestMatch = null;
    
    for (let dbv of dbVariants) {
      if (dbv.name === woltName) {
        bestMatch = dbv;
        break;
      }
    }

    if (bestMatch) {
      // Map it
      if (bestMatch.isVariant) {
        bestMatch.vObj.woltId = woltId;
        bestMatch.prodObj.markModified('variants');
      } else {
        bestMatch.prodObj.woltId = woltId;
        bestMatch.prodObj.markModified('woltId');
      }
      bestMatch.woltId = woltId;
      mappedCount++;
    }
  });

  for (let prod of products) {
    if (prod.isModified()) {
      await prod.save();
    }
  }

  console.log(`Exactly mapped ${mappedCount} Wolt IDs.`);
  process.exit();
}
run().catch(console.error);
