import mongoose from "mongoose";
import ExcelJS from "exceljs";
import Product from "./models/Product.js";
import dotenv from "dotenv";

dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const workbookIn = new ExcelJS.Workbook();
  await workbookIn.xlsx.readFile("../Twayba_Admin-master/[twayba-discount-store]-[2026-06-10]-[16_44].xlsx");
  const worksheetIn = workbookIn.worksheets[0];

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
  worksheetIn.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; 
    const woltId = row.getCell(1).value?.toString()?.trim();
    const woltName = row.getCell(2).value?.toString()?.trim();

    if (!woltId || !woltName) return;

    if (!mappedWoltIds.has(woltId)) {
      unmappedWolt.push({ woltId, woltName });
    }
  });

  let unmappedDB = dbVariants.filter(v => !v.woltId);

  // Write to a new excel
  const workbookOut = new ExcelJS.Workbook();
  
  const sheet1 = workbookOut.addWorksheet("Unmapped Wolt Products");
  sheet1.columns = [
    { header: "Wolt ID", key: "id", width: 30 },
    { header: "Wolt Name", key: "name", width: 50 }
  ];
  for (let u of unmappedWolt) {
    sheet1.addRow({ id: u.woltId, name: u.woltName });
  }

  const sheet2 = workbookOut.addWorksheet("Unmapped DB Products");
  sheet2.columns = [
    { header: "Database Name", key: "name", width: 80 }
  ];
  for (let u of unmappedDB) {
    sheet2.addRow({ name: u.name });
  }

  await workbookOut.xlsx.writeFile("../Twayba_Admin-master/Unmapped_Products_Checklist.xlsx");
  console.log("Saved to Unmapped_Products_Checklist.xlsx");
  process.exit();
}

run().catch(console.error);
