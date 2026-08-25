import ExcelJS from "exceljs";

async function run() {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile("output.xlsx");
  const worksheet = workbook.worksheets[0];
  const row1 = worksheet.getRow(1).values;
  console.log("Headers:", row1);
  const row2 = worksheet.getRow(2).values;
  console.log("Row 2:", row2);
  const row3 = worksheet.getRow(3).values;
  console.log("Row 3:", row3);
}
run().catch(console.error);
