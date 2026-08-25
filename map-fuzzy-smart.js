import mongoose from "mongoose";
import ExcelJS from "exceljs";
import Product from "./models/Product.js";
import dotenv from "dotenv";

dotenv.config();

function normalize(str) {
  // convert to lowercase
  let s = str.toLowerCase();
  
  // separate numbers and letters (e.g., 2.5kg -> 2.5 kg)
  s = s.replace(/([0-9]+)([a-z]+)/g, '$1 $2');
  
  // replace punctuation with space
  s = s.replace(/[^a-z0-9]/g, ' ');
  
  // remove common stop words that might be omitted
  s = s.replace(/\b(with|and|for|size|color|dimension|dimensions)\b/g, ' ');

  // remove multiple spaces
  s = s.replace(/\s+/g, ' ').trim();

  // split and sort words
  return s.split(' ').filter(Boolean);
}

function getOverlapScore(woltWords, dbWords) {
  let overlap = 0;
  for (let ww of woltWords) {
    if (dbWords.includes(ww)) overlap++;
  }
  return overlap / Math.max(woltWords.length, dbWords.length);
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
  let remainingUnmapped = [];

  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; 
    const woltId = row.getCell(1).value?.toString()?.trim();
    const woltName = row.getCell(2).value?.toString()?.trim();

    if (!woltId || !woltName) return;
    
    const woltWords = normalize(woltName);

    let bestMatches = [];
    let bestScore = 0;

    for (let dbv of dbVariants) {
      if (dbv.woltId) continue; // Already mapped
      
      const score = getOverlapScore(woltWords, dbv.words);
      const subsetMatch = isSubset(woltWords, dbv.words);
      
      let finalScore = score;
      if (subsetMatch) finalScore += 0.5; // Bonus for subset

      if (finalScore > bestScore) {
        bestScore = finalScore;
        bestMatches = [dbv];
      } else if (finalScore === bestScore) {
        bestMatches.push(dbv);
      }
    }

    // High confidence threshold (e.g. 70% overlap or subset match)
    if (bestScore > 0.65 && bestMatches.length === 1) {
      let bestMatch = bestMatches[0];
      if (bestMatch.isVariant) {
        bestMatch.vObj.woltId = woltId;
        bestMatch.prodObj.markModified('variants');
      } else {
        bestMatch.prodObj.woltId = woltId;
        bestMatch.prodObj.markModified('woltId');
      }
      bestMatch.woltId = woltId; // mark in memory
      mappedCount++;
      console.log(`Smart Mapped: [${woltName}] -> [${bestMatch.name}] (Score: ${bestScore.toFixed(2)})`);
    } else {
      remainingUnmapped.push(woltName);
    }
  });

  for (let prod of products) {
    if (prod.isModified()) {
      await prod.save();
    }
  }

  console.log(`\nSmart mapped ${mappedCount} MORE Wolt IDs.`);
  console.log(`There are ${remainingUnmapped.length} products still unmapped.\n`);
  
  process.exit();
}

run().catch(console.error);
