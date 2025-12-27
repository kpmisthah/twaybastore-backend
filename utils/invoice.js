// utils/invoice.js
import PDFDocument from "pdfkit";
import axios from "axios";

const formatCurrency = (n) => `€${Number(n || 0).toFixed(2)}`;

export const generateInvoiceBuffer = async (order, userName) => {
  const doc = new PDFDocument({
    size: "A4",
    margin: 50,
  });

  const buffers = [];
  doc.on("data", buffers.push.bind(buffers));

  const BRAND_BLUE = "#056cf2";
  const logoUrl = "https://www.twayba.com/emailLogo.png";

  const shipping = order.shipping || {};
  const contact = order.contact || {};

  const customerName = shipping.name || contact.name || userName || "Customer";
  const email = shipping.email || contact.email || "";
  const phone = shipping.phone || contact.phone || "";
  const address = [
    shipping.address,
    shipping.city,
    shipping.state,
    shipping.zip,
    shipping.country || "Malta",
  ]
    .filter(Boolean)
    .join(", ");

  const total = Number(order.finalTotal || order.total || 0);
  const discount = Number(order.discountAmount || 0);
  const subtotal = total + discount;

  /* ---------------- HEADER ---------------- */
  doc.rect(0, 0, doc.page.width, 80).fill(BRAND_BLUE);

  try {
    const logoResponse = await axios.get(logoUrl, {
      responseType: "arraybuffer",
    });
    const logoBuffer = Buffer.from(logoResponse.data);
    doc.image(logoBuffer, doc.page.width / 2 - 50, 15, { width: 100 });
  } catch (err) {
    console.log("Logo failed to load:", err.message);
  }

  doc
    .fillColor("#fff")
    .font("Helvetica-Bold")
    .fontSize(22)
    .text("INVOICE", { align: "center", continued: false });

  doc.moveDown(3).fillColor("#000");

  /* ---------------- BILLING DETAILS ---------------- */
  doc.fontSize(11).font("Helvetica-Bold").text("Bill To:");
  doc.font("Helvetica");

  doc.text(customerName);
  if (address) doc.text(address);
  if (email) doc.text(email);
  if (phone) doc.text(phone);

  const rightX = 320;
  doc.font("Helvetica-Bold").text("Order Details:", rightX, 150);
  doc
    .font("Helvetica")
    .text(`Order ID: ${order._id}`, rightX)
    .text(`Order Date: ${new Date(order.createdAt).toLocaleString()}`, rightX)
    .text(
      `Payment: ${order.isPaid ? "Paid (Card)" : "Cash on Delivery"}`,
      rightX
    );

  doc.moveDown(2);

  /* ---------------- TABLE HEADER ---------------- */
  doc.fontSize(12).font("Helvetica-Bold").text("Products");
  doc.moveDown(0.5);

  const col1 = 50;
  const col2 = 280;
  const col3 = 350;
  const col4 = 430;
  const tableTop = doc.y;

  doc.text("Product", col1, tableTop);
  doc.text("Qty", col2, tableTop, { width: 40, align: "center" });
  doc.text("Price", col3, tableTop, { width: 60, align: "right" });
  doc.text("Total", col4, tableTop, { width: 80, align: "right" });

  doc
    .moveTo(col1, tableTop + 15)
    .lineTo(550, tableTop + 15)
    .strokeColor("#ddd")
    .stroke();

  doc.moveDown(1).font("Helvetica").fontSize(11);

  /* ---------------- TABLE ROWS ---------------- */
  order.items.forEach((item) => {
    const qty = Number(item.qty);
    const price = Number(item.price);
    const lineTotal = qty * price;
    const variant =
      item.color || item.dimensions
        ? `${item.color || ""} ${
            item.dimensions !== "N/A" ? item.dimensions : ""
          }`.trim()
        : "";

    doc.text(item.name || "Product", col1);
    if (variant) {
      doc.fontSize(9).fillColor("#666").text(variant, col1, doc.y);
      doc.fontSize(11).fillColor("#000");
    }

    doc.text(qty.toString(), col2, doc.y - 12, { align: "center" });
    doc.text(formatCurrency(price), col3, doc.y - 12, { align: "right" });
    doc.text(formatCurrency(lineTotal), col4, doc.y - 12, { align: "right" });

    doc.moveDown(1.4);
  });

  doc.moveTo(col1, doc.y).lineTo(550, doc.y).strokeColor("#ddd").stroke();
  doc.moveDown(1.5);

  /* ---------------- TOTALS ---------------- */
  const totalsX = col4;

  doc.fontSize(11).font("Helvetica");
  doc.text(`Subtotal: ${formatCurrency(subtotal)}`, totalsX, doc.y, {
    align: "right",
  });
  doc.text("Delivery: Free (24h Malta)", totalsX, doc.y + 14, {
    align: "right",
  });

  if (discount > 0) {
    doc.text(`Discount: -${formatCurrency(discount)}`, totalsX, doc.y + 28, {
      align: "right",
    });
  }

  doc.font("Helvetica-Bold").fontSize(13);
  doc.text(`Final Total: ${formatCurrency(total)}`, totalsX, doc.y + 50, {
    align: "right",
  });

  doc.moveDown(5);

  /* ---------------- FOOTER ---------------- */
  doc.fontSize(10).fillColor("#555");
  doc.text("Thank you for shopping with Twayba 💙", { align: "center" });
  doc.text("support@twayba.com • www.twayba.com", { align: "center" });

  /* ---------------- RETURN BUFFER SAFELY ---------------- */
  return new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(buffers)));
    doc.on("error", reject);
    doc.end();
  });
};
