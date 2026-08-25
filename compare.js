import ExcelJS from "exceljs";

async function run() {
  const w1 = new ExcelJS.Workbook();
  await w1.xlsx.readFile("../Twayba_Admin-master/[twayba-discount-store]-[2026-06-10]-[16_44].xlsx");
  const ws1 = w1.worksheets[0];
  
  const w2 = new ExcelJS.Workbook();
  await w2.xlsx.readFile("output2.xlsx");
  const ws2 = w2.worksheets[0];

  const map1 = {};
  ws1.eachRow((row, i) => {
    if (i === 1) return;
    map1[row.getCell(2).value] = row.getCell(1).value;
  });

  ws2.eachRow((row, i) => {
    if (i === 1) return;
    const name = row.getCell(2).value;
    const exportedId = row.getCell(1).value;
    
    // the name in ws2 is the DATABASE name, not the WOLT name!
    // So the user sees a product in the export with WoltID = X, but they look up the WoltID in their excel sheet and the name is different!
  });
}
