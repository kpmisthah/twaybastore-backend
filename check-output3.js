import ExcelJS from "exceljs";

async function run() {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile("output2.xlsx");
  const worksheet = workbook.worksheets[0];
  console.log("Total rows:", worksheet.rowCount);
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber <= 5) {
      console.log(`Row ${rowNumber}:`, row.values);
    }
  });
}
run().catch(console.error);
