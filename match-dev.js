import mongoose from "mongoose";
import ExcelJS from "exceljs";
import Product from "./models/Product.js";
import dotenv from "dotenv";
dotenv.config({ path: ".env.development" });

function levenshtein(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix = [];
  for (let i = 0; i <= b.length; i++) { matrix[i] = [i]; }
  for (let j = 0; j <= a.length; j++) { matrix[0][j] = j; }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1)
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

function getSimilarity(s1, s2) {
  s1 = s1.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  s2 = s2.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();

  const words1 = s1.split(' ').filter(w => w);
  const words2 = s2.split(' ').filter(w => w);

  let overlap = 0;
  for (let w of words1) {
    if (words2.includes(w)) overlap++;
  }
  const overlapRatio = overlap / Math.max(words1.length, words2.length);

  const levDist = levenshtein(s1, s2);
  const maxLen = Math.max(s1.length, s2.length);
  const levScore = 1 - levDist / maxLen;

  return overlapRatio * 0.7 + levScore * 0.3;
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
        name: prod.name,
        isVariant: false,
        prodObj: prod,
        woltId: prod.woltId
      });
    } else {
      for (let v of prod.variants) {
        dbVariants.push({
          id: v._id,
          name: `${prod.name} ${v.color || ""} ${v.dimensions || ""}`.trim(),
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

    let bestMatch = null;
    let bestScore = -1;

    for (let dbv of dbVariants) {
      if (dbv.woltId === woltId) {
        bestMatch = dbv;
        bestScore = 2; // already matched
        break;
      }
      
      const score = getSimilarity(woltName, dbv.name);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = dbv;
      }
    }

    if (bestMatch && bestScore < 2) {
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

  console.log(`Successfully mapped ${mappedCount} new Wolt IDs.`);
  process.exit();
}

run().catch(console.error);
