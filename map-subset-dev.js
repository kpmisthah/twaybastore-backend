import mongoose from "mongoose";
import ExcelJS from "exceljs";
import Product from "./models/Product.js";
import dotenv from "dotenv";
dotenv.config({ path: ".env.development" });

function getNormalizedWords(str) {
  return str.toLowerCase().replace(/[^a-z0-9]/g, ' ').split(' ').filter(Boolean);
}

function wordsMatch(w1, w2) {
  if (w1.length !== w2.length) return false;
  for (let i = 0; i < w1.length; i++) {
    if (w1[i] !== w2[i]) return false;
  }
  return true;
}

function isSubset(woltWords, dbWords) {
  for (let ww of woltWords) {
    if (!dbWords.includes(ww)) return false;
  }
  return true;
}

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
        words: getNormalizedWords(prod.name),
        isVariant: false,
        prodObj: prod,
        woltId: prod.woltId
      });
    } else {
      for (let v of prod.variants) {
        const variantStr = `${prod.name} ${v.color || ""} ${v.dimensions || ""}`.trim();
        dbVariants.push({
          id: v._id,
          name: variantStr,
          words: getNormalizedWords(variantStr),
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
    const woltName = row.getCell(2).value?.toString()?.trim();

    if (!woltId || !woltName) return;
    
    const woltWords = getNormalizedWords(woltName);

    let bestMatch = null;
    let matchCount = 0;

    for (let dbv of dbVariants) {
      if (dbv.woltId) continue;
      if (isSubset(woltWords, dbv.words) || wordsMatch(woltWords, dbv.words)) {
        bestMatch = dbv;
        matchCount++;
      }
    }

    if (matchCount === 1 && bestMatch) {
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

  console.log(`Subset matched ${mappedCount} NEW Wolt IDs in dev DB.`);
  process.exit();
}
run().catch(console.error);
