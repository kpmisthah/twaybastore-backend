import mongoose from "mongoose";
import ExcelJS from "exceljs";
import Product from "./models/Product.js";
import dotenv from "dotenv";

dotenv.config();

function normalize(str) {
  let s = str.toLowerCase();
  s = s.replace(/([0-9]+)([a-z]+)/g, '$1 $2');
  s = s.replace(/[^a-z0-9]/g, ' ');
  s = s.replace(/\b(with|and|for|size|color|dimension|dimensions|by|x|cm|mm|kg|m|pcs|in|inch|l|set|of)\b/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s.split(' ').filter(Boolean);
}

function getScore(woltWords, dbWords) {
  let overlap = 0;
  let missingNumbers = 0;
  
  let wNumbers = woltWords.filter(w => !isNaN(w));
  let wLetters = woltWords.filter(w => isNaN(w));

  let dbNumbers = dbWords.filter(w => !isNaN(w));
  
  for (let wn of wNumbers) {
    if (dbNumbers.includes(wn)) {
      overlap += 2; // numbers are very important
    } else {
      missingNumbers++;
    }
  }

  for (let wl of wLetters) {
    if (dbWords.includes(wl)) {
      overlap += 1;
    }
  }

  // If a wolt product specifies a number but the DB doesn't have it, it's a risky match
  // UNLESS the DB base name has the number
  let subsetChars = wLetters.filter(w => dbWords.includes(w)).length / wLetters.length;

  return { overlap, missingNumbers, subsetChars };
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
    
    // Check if already mapped
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
    let maxOverlap = 0;

    for (let dbv of dbVariants) {
      if (dbv.woltId) continue; 
      
      const { overlap, missingNumbers, subsetChars } = getScore(woltWords, dbv.words);
      
      // Strict constraints: must have subset of letters > 0.4 OR all numbers must match
      if (missingNumbers === 0 && subsetChars > 0.3) {
        if (overlap > maxOverlap) {
          maxOverlap = overlap;
          bestMatches = [dbv];
        } else if (overlap === maxOverlap) {
          bestMatches.push(dbv);
        }
      }
    }

    if (maxOverlap > 0 && bestMatches.length === 1) {
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
      console.log(`FORCED MAP: [${woltName}] -> [${bestMatch.name}] (Overlap: ${maxOverlap})`);
    }
  });

  for (let prod of products) {
    if (prod.isModified()) {
      await prod.save();
    }
  }

  console.log(`\nFORCED mapped ${mappedCount} MORE Wolt IDs.`);
  process.exit();
}

run().catch(console.error);
