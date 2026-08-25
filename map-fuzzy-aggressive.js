import mongoose from "mongoose";
import ExcelJS from "exceljs";
import Product from "./models/Product.js";
import dotenv from "dotenv";

dotenv.config();

function normalize(str) {
  let s = str.toLowerCase();
  s = s.replace(/([0-9]+)([a-z]+)/g, '$1 $2');
  s = s.replace(/[^a-z0-9]/g, ' ');
  s = s.replace(/\b(with|and|for|size|color|dimension|dimensions)\b/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s.split(' ').filter(Boolean);
}

function getOverlapScore(woltWords, dbWords) {
  let overlap = 0;
  for (let ww of woltWords) {
    if (dbWords.includes(ww)) overlap++;
  }
  return overlap / Math.max(woltWords.length, dbWords.length);
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
        words: normalize(prod.name),
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
          words: normalize(variantStr),
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
    
    // Check if already mapped globally (by checking if this woltId exists in dbVariants)
    let alreadyMapped = false;
    for (let dbv of dbVariants) {
      if (dbv.woltId === woltId) {
        alreadyMapped = true;
        break;
      }
    }
    if (alreadyMapped) return;

    const woltWords = normalize(woltName);
    let bestMatches = [];
    let bestScore = 0;

    for (let dbv of dbVariants) {
      if (dbv.woltId) continue; 
      
      const score = getOverlapScore(woltWords, dbv.words);
      let isSubset = true;
      for(let w of woltWords) {
         if(!dbv.words.includes(w)) { isSubset = false; break; }
      }
      
      let finalScore = score;
      if (isSubset) finalScore += 0.5;

      if (finalScore > bestScore) {
        bestScore = finalScore;
        bestMatches = [dbv];
      } else if (finalScore === bestScore) {
        bestMatches.push(dbv);
      }
    }

    // Lowered threshold to 0.4 since we normalize better
    if (bestScore > 0.4 && bestMatches.length === 1) {
      let bestMatch = bestMatches[0];
      if (bestMatch.isVariant) {
        bestMatch.vObj.woltId = woltId;
        bestMatch.prodObj.markModified('variants');
      } else {
        bestMatch.prodObj.woltId = woltId;
        bestMatch.prodObj.markModified('woltId');
      }
      bestMatch.woltId = woltId; 
      mappedCount++;
      console.log(`Aggressive Mapped: [${woltName}] -> [${bestMatch.name}] (Score: ${bestScore.toFixed(2)})`);
    }
  });

  for (let prod of products) {
    if (prod.isModified()) {
      await prod.save();
    }
  }

  console.log(`\nAggressive mapped ${mappedCount} MORE Wolt IDs.`);
  
  process.exit();
}

run().catch(console.error);
