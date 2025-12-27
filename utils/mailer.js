// utils/mailer.js
import nodemailer from "nodemailer";
import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import { generateInvoiceBuffer } from "./invoice.js";


const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS, // Use a Gmail App Password
  },
});

// Optional: quick health check on startup (won’t crash app)
transporter.verify((err, success) => {
  if (err) {
    console.error("❌ SMTP connection error:", err.message);
  } else {
    console.log("✅ SMTP server is ready to take messages");
  }
});

/* ------------------------- Shared helpers ------------------------- */
function formatCurrency(n) {
  const num = Number(n) || 0;
  try {
    return new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" }).format(num);
  } catch {
    return `€${num.toFixed(2)}`;
  }
}

function escapeHtml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}


export const generateInvoice = (order, userName) => {
  return new Promise((resolve, reject) => {
    const invoiceDir = path.resolve("invoices");
    if (!fs.existsSync(invoiceDir)) fs.mkdirSync(invoiceDir);

    const fileName = `Invoice-${order._id}.pdf`;
    const filePath = path.join(invoiceDir, fileName);

    const doc = new PDFDocument({ margin: 40 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    doc.fontSize(22).text("TWAYBA INVOICE", { align: "center" });
    doc.moveDown();

    doc.fontSize(14).text(`Invoice ID: ${order._id}`);
    doc.text(`Customer: ${userName}`);
    doc.text(`Email: ${order.shipping?.email || "N/A"}`);
    doc.text(`Phone: ${order.shipping?.phone || "N/A"}`);
    doc.text(`Date: ${new Date(order.createdAt).toLocaleString()}`);
    doc.moveDown();

    doc.fontSize(16).text("Items:", { underline: true });
    order.items.forEach((item, i) => {
      doc.fontSize(12).text(`${i + 1}. ${item.name} x${item.qty} - €${(item.qty * item.price).toFixed(2)}`);
    });

    doc.moveDown();
    doc.fontSize(14).text(`Total Amount: €${Number(order.finalTotal).toFixed(2)}`, {
      align: "right",
      bold: true
    });

    doc.end();

    stream.on("finish", () => resolve(filePath));
    stream.on("error", reject);
  });
};

/* ------------------ Generic OTP email (verification / reset) ------------------ */
export const sendOtpEmail = async (to, otp, purpose = "Verification") => {
  const mailOptions = {
    from: `"Twayba" <${process.env.SMTP_USER}>`,
    to,
    subject: `Your ${purpose} Code: ${otp}`,
    html: `
      <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 20px;">
        <div style="text-align:center; margin-bottom: 12px;">
          <img src="https://res.cloudinary.com/dwgn4j1nu/image/upload/v1753372667/lqvyv4psgthcxzowovyp.png" alt="Twayba" style="height:42px"/>
        </div>
        <h2 style="margin: 8px 0 0; color:#0c41a7;">${purpose} Code</h2>
        <p style="color:#333">Use the code below to complete your ${purpose.toLowerCase()}:</p>
        <div style="font-size:28px; font-weight:800; letter-spacing: 3px; text-align:center; padding: 12px 0; color:#0c41a7;">
          ${otp}
        </div>
        <p style="color:#666; font-size:14px;">This code will expire in <b>10 minutes</b>. If you didn’t request this, you can safely ignore this email.</p>
      </div>
    `,
  };

  await transporter.sendMail(mailOptions);
};


// Email marketing

/* ---------------------- Broadcast / Marketing Email ---------------------- */
export const sendBroadcastEmail = async ({ recipients, subject, htmlContent }) => {
  if (!recipients?.length) throw new Error("No recipients provided");

  const mailOptions = {
    from: `"Twayba" <${process.env.SMTP_USER}>`,
    bcc: recipients,
    subject,
    html: `
      <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:600px;margin:auto;background:#fff;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,0.08);">
        <div style="text-align:center;padding:24px 0;">
          <img src="https://res.cloudinary.com/dwgn4j1nu/image/upload/v1753372667/lqvyv4psgthcxzowovyp.png" alt="Twayba Logo" style="height:40px;margin-bottom:10px;"/>
          <h2 style="color:#0c41a7;margin:0;">Special from Twayba 💙</h2>
        </div>

        <div style="padding:0 32px 20px 32px;font-size:15px;color:#333;line-height:1.6;">
          ${htmlContent}
        </div>

        <div style="padding:20px;text-align:center;font-size:13px;color:#999;border-top:1px solid #eee;">
          <p>© ${new Date().getFullYear()} Twayba. All rights reserved.</p>
          <p><a href="https://www.twayba.com" style="color:#056cf2;text-decoration:none;">Visit Twayba.com</a></p>
        </div>
      </div>
    `,
  };

  await transporter.sendMail(mailOptions);
};

/* --------------------------- Order Confirmation Email --------------------------- */
export const sendOrderMail = async (to, userName, order) => {
  const orderItems = order.items
    .map(
      (item) => `
      <tr>
        <td style="padding: 8px 0; border-bottom:1px solid #f1f1f1;">${item.name}</td>
        <td align="center" style="padding: 8px 0; border-bottom:1px solid #f1f1f1;">${item.qty}</td>
      </tr>`
    )
    .join("");

  // 🔥 Generate invoice PDF buffer
  const invoiceBuffer = await generateInvoiceBuffer(order, userName);

  const mailOptions = {
    from: `"Twayba" <${process.env.SMTP_USER}>`,
    to,
    subject: "🎉 Order Confirmed! | Twayba",
    attachments: [
      {
        filename: `Invoice-${order._id}.pdf`,
        content: invoiceBuffer,
        contentType: "application/pdf",
      },
    ],
    html: `
      <div style="background: #fff; padding: 0; margin:0; min-height: 100vh;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background: #fff;">
          <tr>
            <td align="center" style="padding: 0;">
              <table width="100%" style="max-width: 460px; background: #fff; border-radius: 18px; box-shadow: 0 8px 32px 0 rgba(31,38,135,0.10); font-family: 'Segoe UI', Arial, sans-serif; border: none; margin: 24px auto;">
                <tr>
                  <td style="padding: 0;">
                    <div style="width:100%; background:#fff; border-radius: 18px 18px 0 0; text-align:center; padding: 36px 0 10px 0;">
                      <img src="https://res.cloudinary.com/dwgn4j1nu/image/upload/v1753372667/lqvyv4psgthcxzowovyp.png" alt="Twayba Logo" style="width: 160px; max-width:90vw; height: auto; margin: 0 auto; display:block;" />
                    </div>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 0 32px;">
                    <h1 style="color: #0c41a7; font-size: 28px; margin: 10px 0 0 0; letter-spacing: 1px; font-weight: 800; text-align: left;">
                      Order Confirmed!
                    </h1>
                    <hr style="border:none;border-top:2px solid #056cf2; width:48px; margin:12px 0 0 0;">
                  </td>
                </tr>
                <tr>
                  <td style="padding: 22px 32px 8px 32px; text-align: left;">
                    <h2 style="margin: 0 0 8px 0; font-weight: 600; color: #1A2237; font-size: 19px;">
                      Hi ${userName || "Customer"},
                    </h2>
                    <p style="color: #3b3b3b; font-size: 15px; margin-bottom: 0;">
                      Thank you for shopping with <b style="color:#056cf2;">Twayba</b>!<br>
                      Your order is now confirmed. Here’s your order summary:
                    </p>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 0 32px 18px 32px;">
                    <div style="background: #f6faff; border-left:4px solid #056cf2; border-radius: 9px; padding: 14px 18px; margin-bottom: 12px;">
                      <table width="100%" style="font-size: 15px; color: #2d334a;">
                        <tr>
                          <td><b>Order ID:</b></td>
                          <td align="right" style="color:#111;">${order._id}</td>
                        </tr>
                        <tr>
                          <td><b>Total Amount:</b></td>
                          <td align="right" style="font-weight: bold; color:#056cf2; font-size: 17px;">
                            €${Number(order.total).toFixed(2)}
                          </td>
                        </tr>
                        <tr>
                          <td><b>Estimated Delivery:</b></td>
                          <td align="right"><span style="color:#1e8af9; font-weight: 600;">24 Hours</span></td>
                        </tr>
                      </table>
                    </div>
                    <div style="margin: 10px 0 8px 0;">
                      <b>Items Ordered:</b>
                      <table width="100%" style="margin-top: 6px; font-size: 14px; background: #fff; border-radius: 7px;">
                        <thead>
                          <tr style="color: #446; background: #f0f4fc;">
                            <th align="left" style="padding: 7px 4px;">Product</th>
                            <th align="center" style="padding: 7px 4px;">Qty</th>
                          </tr>
                        </thead>
                        <tbody>
                          ${orderItems}
                        </tbody>
                      </table>
                    </div>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 0 32px 22px 32px;">
                    <p style="font-size: 14px; color: #0c41a7; margin: 16px 0 6px 0; text-align:center;">
                      <b>Your order will be delivered soon.<br>
                      You’ll receive updates by email & SMS.</b>
                    </p>
                    <div style="height: 1px; background: #eaf1fa; margin: 18px 0 12px 0;"></div>
                    <p style="color: #6f7c97; font-size: 13px; text-align: center;">
                      Questions? <a href="mailto:support@twayba.com" style="color: #056cf2; text-decoration: none;">Contact support</a>
                    </p>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 0 0 18px 0; text-align: center;">
                    <span style="color: #b2b2b2; font-size: 12px;">&copy; ${new Date().getFullYear()} Twayba. All rights reserved.</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </div>
    `,
  };

  await transporter.sendMail(mailOptions);
};

/* ------------------------------ Contact Form Email ------------------------------ */
export const sendContactMail = async ({
  inbox,         // where you receive messages (e.g. support@twayba.com)
  userEmail,     // logged-in user's email (used as Reply-To)
  subject,
  message,
}) => {
  const safeSubject = (subject || "").slice(0, 140) || "New contact message";
  const safeBody = (message || "").slice(0, 5000);

  const mailOptions = {
    from: `"Twayba" <${process.env.SMTP_USER}>`, // MUST be your SMTP sender
    to: inbox || process.env.SUPPORT_INBOX || process.env.SMTP_USER,
    replyTo: userEmail || undefined,             // so you can reply directly to the user
    subject: `📬 Contact: ${safeSubject}`,
    html: `
      <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 20px;">
        <div style="text-align:center; margin-bottom: 12px;">
          <img src="https://res.cloudinary.com/dwgn4j1nu/image/upload/v1753372667/lqvyv4psgthcxzowovyp.png" alt="Twayba" style="height:42px"/>
        </div>
        <h2 style="margin: 8px 0 0; color:#0c41a7;">New Contact Message</h2>
        <p style="color:#333; margin: 6px 0 12px 0;">
          <b>From:</b> ${userEmail ? userEmail.replace(/</g, "&lt;").replace(/>/g, "&gt;") : "Unknown"}
        </p>
        <div style="background:#f6faff; border-left:4px solid #056cf2; border-radius:9px; padding:14px 18px;">
          <div style="white-space:pre-wrap; color:#2d334a; font-size:15px; line-height:1.5;">
            ${safeBody.replace(/</g, "&lt;").replace(/>/g, "&gt;")}
          </div>
        </div>
      </div>
    `,
  };

  await transporter.sendMail(mailOptions);
};

/* ---------------------------- Order Cancellation Email ---------------------------- */
export const sendCancelMail = async (to, userName, order) => {
  const orderItems = order.items
    .map(
      (item) => `
      <tr>
        <td style="padding: 8px 0; border-bottom:1px solid #f1f1f1;">${item.name}</td>
        <td align="center" style="padding: 8px 0; border-bottom:1px solid #f1f1f1;">${item.qty}</td>
      </tr>`
    )
    .join("");

  const refundLine = order.isPaid
    ? `
      <tr>
        <td><b>Refund Status:</b></td>
        <td align="right" style="color:#1e8af9; font-weight:600;">
          Initiated
        </td>
      </tr>
      <tr>
        <td><b>Refund Method:</b></td>
        <td align="right" style="color:#1e8af9;">
          Original Payment Method
        </td>
      </tr>
      `
    : "";

  const refundMsg = order.isPaid
    ? `<b style="color:#1e8af9;">Your refund has already been initiated and the amount will be credited back to your original payment method within <span style="color:#056cf2;">5–10 business days</span> (often much faster, depending on your bank/card).</b><br>`
    : `<span style="color:#6f7c97;">You will also receive a confirmation from your bank or payment provider once the refund is completed.</span>`;

  const mailOptions = {
    from: `"Twayba" <${process.env.SMTP_USER}>`,
    to,
    subject: "Order Cancelled & Refund Initiated | Twayba",
    html: `
    <div style="background: #fff; padding: 0; margin:0; min-height: 100vh;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background: #fff;">
        <tr>
          <td align="center" style="padding: 0;">
            <table width="100%" style="max-width: 460px; background: #fff; border-radius: 18px; box-shadow: 0 8px 32px 0 rgba(31,38,135,0.10); font-family: 'Segoe UI', Arial, sans-serif; border: none; margin: 24px auto;">
              <tr>
                <td style="padding: 0;">
                  <div style="width:100%; background:#fff; border-radius: 18px 18px 0 0; text-align:center; padding: 36px 0 10px 0;">
                    <img src="https://res.cloudinary.com/dwgn4j1nu/image/upload/v1753372667/lqvyv4psgthcxzowovyp.png" alt="Twayba Logo" style="width: 160px; max-width:90vw; height: auto; margin: 0 auto; display:block;" />
                  </div>
                </td>
              </tr>
              <tr>
                <td style="padding: 0 32px;">
                  <h1 style="color: #c20828; font-size: 26px; margin: 10px 0 0 0; letter-spacing: 1px; font-weight: 800; text-align: left;">
                    Order Cancelled & Refund Initiated
                  </h1>
                  <hr style="border:none;border-top:2px solid #c20828; width:48px; margin:12px 0 0 0;">
                </td>
              </tr>
              <tr>
                <td style="padding: 22px 32px 8px 32px; text-align: left;">
                  <h2 style="margin: 0 0 8px 0; font-weight: 600; color: #1A2237; font-size: 19px;">
                    Hi ${userName || "Customer"},
                  </h2>
                  <p style="color: #3b3b3b; font-size: 15px; margin-bottom: 0;">
                    As per your request, your order at <b style="color:#056cf2;">Twayba</b> has been <b style="color:#c20828;">cancelled</b>.
                  </p>
                  <p style="color: #333; font-size: 15px; margin: 8px 0 0 0;">
                    ${refundMsg}
                  </p>
                </td>
              </tr>
              <tr>
                <td style="padding: 0 32px 18px 32px;">
                  <div style="background: #fff6f6; border-left:4px solid #c20828; border-radius: 9px; padding: 14px 18px; margin-bottom: 12px;">
                    <table width="100%" style="font-size: 15px; color: #2d334a;">
                      <tr>
                        <td><b>Order ID:</b></td>
                        <td align="right" style="color:#111;">${order._id}</td>
                      </tr>
                      <tr>
                        <td><b>Total Amount:</b></td>
                        <td align="right" style="font-weight: bold; color:#056cf2; font-size: 17px;">
                          €${Number(order.total).toFixed(2)}
                        </td>
                      </tr>
                      <tr>
                        <td><b>Cancellation Reason:</b></td>
                        <td align="right" style="color:#c20828;">${order.cancelReason || "Not specified"}</td>
                      </tr>
                      ${refundLine}
                    </table>
                  </div>
                  <div style="margin: 10px 0 8px 0;">
                    <b>Items Ordered:</b>
                    <table width="100%" style="margin-top: 6px; font-size: 14px; background: #fff; border-radius: 7px;">
                      <thead>
                        <tr style="color: #446; background: #f0f4fc;">
                          <th align="left" style="padding: 7px 4px;">Product</th>
                          <th align="center" style="padding: 7px 4px;">Qty</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${orderItems}
                      </tbody>
                    </table>
                  </div>
                </td>
              </tr>
              <tr>
                <td style="padding: 0 32px 22px 32px;">
                  <p style="font-size: 14px; color: #c20828; margin: 16px 0 6px 0; text-align:center;">
                    <b>Your order has been cancelled and any eligible refund has already been processed.</b>
                  </p>
                  <p style="color: #1e8af9; font-size: 14px; text-align:center; margin-bottom:8px;">
                    If you have any questions or don’t see your refund within 10 business days,<br>please reply to this email or <a href="mailto:support@twayba.com" style="color:#056cf2; text-decoration: none;">contact support</a>.
                  </p>
                  <div style="height: 1px; background: #f7dad9; margin: 18px 0 12px 0;"></div>
                  <p style="color: #6f7c97; font-size: 13px; text-align: center;">
                    Thank you for choosing Twayba. We look forward to serving you again!
                  </p>
                </td>
              </tr>
              <tr>
                <td style="padding: 0 0 18px 0; text-align: center;">
                  <span style="color: #b2b2b2; font-size: 12px;">&copy; ${new Date().getFullYear()} Twayba. All rights reserved.</span>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </div>
    `,
  };

  await transporter.sendMail(mailOptions);
};

/* -------------------------- Welcome Gift Email (5% coupon) -------------------------- */
// export const sendWelcomeGiftEmail = async ({ to, userName, code, expiresAt }) => {
//   const expiresInHrs = Math.ceil((expiresAt.getTime() - Date.now()) / 3600000);

//   const mailOptions = {
//     from: `"Twayba" <${process.env.SMTP_USER}>`,
//     to,
//     subject: `🎁 Welcome ${userName || ""}! Here's your ${process.env.WELCOME_COUPON_PERCENT || 5}% gift 🎉`,
//     html: `
//       <div style="background: #fff; padding: 0; margin:0;">
//         <table width="100%" cellpadding="0" cellspacing="0" style="background: #fff;">
//           <tr>
//             <td align="center">
//               <table width="100%" style="max-width: 460px; background: #fff; border-radius: 18px; box-shadow: 0 8px 32px rgba(31,38,135,0.1); font-family: 'Segoe UI', Arial, sans-serif; margin: 24px auto;">
//                 <tr>
//                   <td style="padding: 36px 0 10px 0; text-align:center;">
//                     <img src="https://res.cloudinary.com/dwgn4j1nu/image/upload/v1753372667/lqvyv4psgthcxzowovyp.png" alt="Twayba Logo" style="width: 160px; height:auto;" />
//                   </td>
//                 </tr>
//                 <tr>
//                   <td style="padding: 0 32px;">
//                     <h1 style="color: #056cf2; font-size: 26px; font-weight: 800; margin: 0 0 4px 0;">
//                       Welcome to Twayba!
//                     </h1>
//                     <p style="font-size: 15px; color: #333; margin: 0 0 16px 0;">
//                       As a warm welcome, here’s a one-time gift code just for you.
//                     </p>
//                   </td>
//                 </tr>
//                 <tr>
//                   <td style="padding: 0 32px;">
//                     <div style="background: #f6faff; border-left: 4px solid #056cf2; border-radius: 9px; padding: 16px 20px; text-align: center;">
//                       <p style="margin: 0 0 6px 0; font-size: 15px; color: #1A2237;">Use this code at checkout:</p>
//                       <div style="font-size: 22px; font-weight: 800; color: #0c41a7; letter-spacing: 3px; padding: 8px 0;">
//                         ${code}
//                       </div>
//                       <p style="font-size: 14px; color: #6f7c97;">Valid for ${expiresInHrs} hours on your first order.</p>
//                     </div>
//                   </td>
//                 </tr>
//                 <tr>
//                   <td style="padding: 22px 32px 28px 32px; text-align:center;">
//                     <a href="${process.env.APP_BASE_URL || "https://www.twayba.com"}" 
//                        style="display: inline-block; background: #056cf2; color: #fff; padding: 12px 20px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 15px;">
//                       Shop Now & Save
//                     </a>
//                     <p style="color: #b2b2b2; font-size: 13px; margin-top: 14px;">
//                       Code expires on: <strong>${expiresAt.toLocaleString()}</strong>
//                     </p>
//                   </td>
//                 </tr>
//                 <tr>
//                   <td align="center" style="padding-bottom: 16px;">
//                     <span style="color: #b2b2b2; font-size: 12px;">&copy; ${new Date().getFullYear()} Twayba. All rights reserved.</span>
//                   </td>
//                 </tr>
//               </table>
//             </td>
//           </tr>
//         </table>
//       </div>
//     `,
//   };

//   await transporter.sendMail(mailOptions);
// };


// Product reminder


/* ------------------------------------------------------------
   BAN NOTIFICATION EMAIL
------------------------------------------------------------ */
export const sendBanNotification = async ({ to, userName, reason }) => {
  const mailOptions = {
    from: `"Twayba Support" <${process.env.EMAIL_USER}>`,
    to,
    subject: "Your Twayba Account Has Been Banned",
    html: `
      <div style="font-family: Arial, sans-serif; color: #333;">
        <div style="text-align:center; padding:20px 0;">
          <img src="https://www.twayba.com/emailLogo.png" alt="Twayba" width="100" />
        </div>
        <h2 style="color:#e63946;">Account Banned</h2>
        <p>Dear ${userName || "Customer"},</p>
        <p>
          We regret to inform you that your Twayba account has been <strong>banned</strong>.
        </p>
        <p><strong>Reason:</strong> ${reason}</p>
        <p>
          If you believe this was a mistake or would like to appeal, please contact our support team at
          <a href="mailto:support@twayba.com">support@twayba.com</a>.
        </p>
        <br/>
        <p>Regards,<br/>The Twayba Team</p>
        <hr style="margin-top:30px; border:none; border-top:1px solid #eee;">
        <p style="font-size:12px; color:#999;">© ${new Date().getFullYear()} Twayba Group. All rights reserved.</p>
      </div>
    `,
  };

  await transporter.sendMail(mailOptions);
};


/* -------------------------- Welcome Email (Blue, Animated) -------------------------- */
export const sendWelcomeEmail = async ({ to, userName }) => {
  const NAME = (userName || "there").replace(/[<>]/g, "");
  const SITE = process.env.APP_BASE_URL || "https://www.twayba.com";
  const LOGO = "https://res.cloudinary.com/dwgn4j1nu/image/upload/v1753372667/lqvyv4psgthcxzowovyp.png";

  // 🔁 Replace these with your hosted GIFs (transparent GIFs look best)
  const CANDLES_GIF_URL = "https://res.cloudinary.com/demo/image/upload/v1699999999/candles-animated.gif";
  const CONFETTI_GIF_URL = "https://res.cloudinary.com/demo/image/upload/v1699999999/confetti-soft.gif";

  const year = new Date().getFullYear();

  const html = `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charSet="utf-8" />
    <meta name="viewport" content="width=device-width"/>
    <meta http-equiv="x-ua-compatible" content="ie=edge"/>
    <title>Welcome to Twayba</title>
    <!-- Preheader (hidden) -->
    <style>
      .preheader { display:none!important; visibility:hidden; opacity:0; color:transparent; height:0; width:0; overflow:hidden; }
      @media screen and (max-width: 600px) {
        .container { width: 100%!important; border-radius: 0!important; }
        .px { padding-left: 20px!important; padding-right: 20px!important; }
        .hero-title { font-size: 28px!important; }
      }
      /* Buttons hover (clients that support) */
      a.btn:hover { filter: brightness(1.05); }
    </style>
  </head>
  <body style="margin:0; padding:0; background:#0c41a7;">
    <div class="preheader">Welcome aboard, ${NAME}! Your exclusive Twayba perks are ready.</div>
    <table role="presentation" width="100%" cellPadding="0" cellSpacing="0" style="background:#0c41a7; min-height:100vh;">
      <tr>
        <td align="center" style="padding:24px 12px;">
          <!-- Card -->
          <table role="presentation" class="container" width="600" cellPadding="0" cellSpacing="0" 
                 style="width:600px; max-width:100%; background:#0c41a7; color:#fff; border-radius:18px; overflow:hidden; box-shadow:0 8px 28px rgba(0,0,0,0.2);">
            <!-- Top Logo -->
            <tr>
              <td align="center" style="padding:28px 24px 10px 24px;">
                <img src="${LOGO}" alt="Twayba" width="160" height="" style="display:block; width:160px; max-width:80%; height:auto;"/>
              </td>
            </tr>

            <!-- Confetti (soft animated background strip) -->
            <tr>
              <td align="center" style="padding:0;">
                <img src="${CONFETTI_GIF_URL}" alt="" width="600" style="display:block; width:100%; max-height:90px; object-fit:cover; opacity:0.35;"/>
              </td>
            </tr>

            <!-- Hero + Candles -->
            <tr>
              <td class="px" align="center" style="padding:16px 32px 8px 32px;">
                <h1 class="hero-title" style="margin:8px 0 4px; font-family:'Segoe UI', Arial, sans-serif; font-weight:800; font-size:32px; line-height:1.24; color:#ffffff;">
                  Welcome to Twayba, ${NAME}! ✨
                </h1>
                <p style="margin:6px 0 0; font-family:'Segoe UI', Arial, sans-serif; font-size:15px; color:#e9f1ff;">
                  We’re delighted you’re here. Discover curated deals, fast delivery, and trusted quality — all in one place.
                </p>
              </td>
            </tr>

            <tr>
              <td align="center" style="padding:10px 24px 6px;">
                <img src="${CANDLES_GIF_URL}" alt="Celebration Candles" 
                     style="display:block; width:240px; max-width:70%; height:auto; filter:drop-shadow(0 6px 24px rgba(0,0,0,0.25)); border-radius:12px;" />
              </td>
            </tr>

            <!-- CTA -->
            <tr>
              <td align="center" style="padding:18px 24px 24px;">
                <a href="${SITE}" class="btn"
                   style="font-family:'Segoe UI', Arial, sans-serif; display:inline-block; background:#ffffff; color:#0c41a7; 
                          text-decoration:none; padding:12px 22px; font-weight:700; border-radius:10px; letter-spacing:.2px;">
                  Start Shopping
                </a>
                <div style="height:10px;"></div>
                <a href="${SITE}/products" 
                   style="font-family:'Segoe UI', Arial, sans-serif; color:#ffffff; text-decoration:underline; font-size:14px;">
                  Explore Categories →
                </a>
              </td>
            </tr>

            <!-- Divider -->
            <tr>
              <td style="padding:0 32px;">
                <hr style="border:none; border-top:1px solid rgba(255,255,255,0.25); margin:0 0 10px 0;"/>
              </td>
            </tr>

            <!-- Quick Perks -->
            <tr>
              <td class="px" style="padding:12px 32px 26px; font-family:'Segoe UI', Arial, sans-serif;">
                <table role="presentation" width="100%" cellPadding="0" cellSpacing="0">
                  <tr>
                    <td width="33%" align="center" style="padding:8px;">
                      <div style="font-weight:700; font-size:14px;">Fast Delivery</div>
                      <div style="font-size:12px; color:#e1ecff;">Across Malta</div>
                    </td>
                    <td width="33%" align="center" style="padding:8px;">
                      <div style="font-weight:700; font-size:14px;">Curated Picks</div>
                      <div style="font-size:12px; color:#e1ecff;">Top Quality</div>
                    </td>
                    <td width="33%" align="center" style="padding:8px;">
                      <div style="font-weight:700; font-size:14px;">Great Value</div>
                      <div style="font-size:12px; color:#e1ecff;">Daily Deals</div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td align="center" style="padding:16px 20px 26px; background:#0b3993;">
                <p style="margin:0; font-family:'Segoe UI', Arial, sans-serif; font-size:12px; color:#cfe0ff;">
                  Need help? <a href="mailto:support@twayba.com" style="color:#fff; text-decoration:underline;">Contact support</a>
                </p>
                <p style="margin:8px 0 0 0; font-family:'Segoe UI', Arial, sans-serif; font-size:12px; color:#cfe0ff;">
                  &copy; ${year} Twayba. All rights reserved.
                </p>
              </td>
            </tr>
          </table>
          <!-- /Card -->
        </td>
      </tr>
    </table>
  </body>
  </html>
  `;

  await transporter.sendMail({
    from: `"Twayba" <${process.env.SMTP_USER}>`,
    to,
    subject: `🎉 Welcome to Twayba, ${NAME}!`,
    html,
  });
};


/* ----------------------- Product View / Reminder Email ----------------------- */
export const sendProductViewMail = async ({ to, userName, product }) => {
  if (!to || !product) return;

  const { name, price, realPrice, discount, images, _id } = product;
  const img = images?.[0] || "https://www.twayba.com/default-product.png";
  const productUrl = `${process.env.APP_BASE_URL || "https://www.twayba.com"}/product/${_id}`;
  const formattedPrice = formatCurrency(price);
  const urgencyMsg = discount > 0 
    ? `🔥 Limited stock — ${discount}% off right now!`
    : "⏰ This product is trending — get it before it’s gone!";

  const mailOptions = {
    from: `"Twayba" <${process.env.SMTP_USER}>`,
    to,
    subject: `👀 Still thinking about ${name}?`,
    html: `
      <div style="font-family: 'Segoe UI', Arial, sans-serif; background:#fff; max-width:520px; margin:0 auto; border-radius:12px; box-shadow:0 4px 16px rgba(0,0,0,0.08); overflow:hidden;">
        <div style="text-align:center; padding:24px;">
          <img src="https://res.cloudinary.com/dwgn4j1nu/image/upload/v1753372667/lqvyv4psgthcxzowovyp.png" alt="Twayba" style="height:40px; margin-bottom:10px;"/>
          <h2 style="color:#0c41a7; margin:8px 0;">We saved this for you 👇</h2>
        </div>

        <div style="padding:0 24px;">
          <div style="border:1px solid #eee; border-radius:10px; overflow:hidden;">
            <img src="${img}" alt="${name}" style="width:100%; max-height:240px; object-fit:contain; background:#fafafa;" />
            <div style="padding:16px;">
              <h3 style="margin:0 0 6px 0; color:#111; font-size:18px;">${escapeHtml(name)}</h3>
              <p style="font-size:15px; color:#444; margin:6px 0;">${urgencyMsg}</p>
              <p style="font-size:16px; font-weight:600; color:#056cf2; margin:6px 0;">
                ${formattedPrice} ${realPrice ? `<span style="text-decoration:line-through; color:#aaa; font-weight:400;">${formatCurrency(realPrice)}</span>` : ""}
              </p>
              <div style="text-align:center; margin-top:16px;">
                <a href="${productUrl}" style="background:#056cf2; color:#fff; padding:10px 18px; border-radius:8px; text-decoration:none; font-weight:600;">Buy Now</a>
                <a href="${productUrl}" style="margin-left:10px; color:#056cf2; font-weight:500; text-decoration:none;">View Product →</a>
              </div>
            </div>
          </div>
        </div>

        <div style="padding:24px; text-align:center; font-size:13px; color:#888;">
          <p>Prices and stock levels may change soon. Don’t miss out!</p>
          <p style="color:#bbb;">&copy; ${new Date().getFullYear()} Twayba. All rights reserved.</p>
        </div>
      </div>
    `,
  };

  await transporter.sendMail(mailOptions);
};

/* ------------------------ Internal New Order Alert (Team/Gmail) ------------------------ */
/**
 * Sends an internal alert to your team inbox when a new order is placed.
 * Uses ORDER_ALERT_EMAIL if provided; otherwise falls back to SMTP_USER.
 * 
 */
export const sendNewOrderAlert = async ({ to, order, customerName }) => {
  const recipient = to || process.env.ORDER_ALERT_EMAIL || process.env.SMTP_USER;

  const shortId = order?._id?.toString()?.slice(-6) || "";
  const subject = `🛒 New Order ${shortId ? `#${shortId} ` : ""}— ${customerName || "Customer"} — Total: ${formatCurrency(order?.total)}`;

  const itemsHtml = (order?.items || [])
    .map((it, idx) => {
      const title = it.title || it.name || "Product";
      const qty = Number(it.qty) || 1;
      const unit = Number(it.price) || 0;
      const line = unit * qty;

      return `
        <tr>
          <td style="padding:8px;border:1px solid #eee;">${idx + 1}</td>
          <td style="padding:8px;border:1px solid #eee;">${escapeHtml(title)}</td>
          <td style="padding:8px;border:1px solid #eee;">${escapeHtml(it.color || "-")}</td>
          <td style="padding:8px;border:1px solid #eee;">${escapeHtml(it.dimensions || "-")}</td>
          <td style="padding:8px;border:1px solid #eee;" align="center">${qty}</td>
          <td style="padding:8px;border:1px solid #eee;" align="right">${formatCurrency(line)}</td>
        </tr>
      `;
    })
    .join("");

  const shipping = order?.shipping || {};
  const contact  = order?.contact  || {};

  const html = `
    <div style="font-family:Inter,Segoe UI,Arial,sans-serif;max-width:720px;margin:0 auto;">
      <h2 style="margin:0 0 12px;">New Order ${shortId ? `#${shortId}` : ""}</h2>
      <p style="margin:0 0 4px;">Placed: ${new Date(order?.createdAt || Date.now()).toLocaleString()}</p>
      <p style="margin:0 0 16px;">Payment: ${order?.isPaid ? "Paid" : "Unpaid"} ${order?.paymentIntentId ? `(PI: ${order.paymentIntentId})` : ""}</p>

      <h3 style="margin:16px 0 8px;">Customer</h3>
      <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #eee;width:100%;">
        <tr><td style="padding:8px;border:1px solid #eee;">Name</td><td style="padding:8px;border:1px solid #eee;">${escapeHtml(shipping.name || contact.name || customerName || "-")}</td></tr>
        <tr><td style="padding:8px;border:1px solid #eee;">Email</td><td style="padding:8px;border:1px solid #eee;">${escapeHtml(shipping.email || contact.email || "-")}</td></tr>
        <tr><td style="padding:8px;border:1px solid #eee;">Phone</td><td style="padding:8px;border:1px solid #eee;">${escapeHtml(shipping.phone || contact.phone || "-")}</td></tr>
        <tr><td style="padding:8px;border:1px solid #eee;">Address</td><td style="padding:8px;border:1px solid #eee;">
          ${escapeHtml(shipping.address || "-")}<br/>
          ${escapeHtml(shipping.city || "")} ${escapeHtml(shipping.state || "")} ${escapeHtml(shipping.zip || "")}<br/>
          ${escapeHtml(shipping.country || "")}
        </td></tr>
      </table>

      <h3 style="margin:16px 0 8px;">Items</h3>
      <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #eee;width:100%;">
        <thead>
          <tr>
            <th style="padding:8px;border:1px solid #eee;text-align:left;">#</th>
            <th style="padding:8px;border:1px solid #eee;text-align:left;">Product</th>
            <th style="padding:8px;border:1px solid #eee;text-align:left;">Color</th>
            <th style="padding:8px;border:1px solid #eee;text-align:left;">Variant</th>
            <th style="padding:8px;border:1px solid #eee;text-align:center;">Qty</th>
            <th style="padding:8px;border:1px solid #eee;text-align:right;">Line Total</th>
          </tr>
        </thead>
        <tbody>${itemsHtml}</tbody>
      </table>

      <h3 style="margin:16px 0 8px;">Totals</h3>
      <p style="font-size:16px;margin:0;">Grand Total: <strong>${formatCurrency(order?.total)}</strong></p>
    </div>
  `;

  const text = (() => {
    const lines = [];
    lines.push(`New Order: ${order?._id || ""}`);
    lines.push(`Customer: ${customerName || "-"}`);
    lines.push(`Paid: ${order?.isPaid ? "Yes" : "No"}`);
    if (order?.paymentIntentId) lines.push(`PaymentIntent: ${order.paymentIntentId}`);
    lines.push(`Total: ${formatCurrency(order?.total)}`);
    lines.push("");
    lines.push("Items:");
    (order?.items || []).forEach((it, i) => {
      const title = it.title || it.name || "Product";
      const qty = Number(it.qty) || 1;
      const unit = Number(it.price) || 0;
      const line = unit * qty;
      lines.push(`${i + 1}. ${title} x${qty} — ${formatCurrency(line)}`);
    });
    return lines.join("\n");
  })();

  await transporter.sendMail({
    from: `"Orders" <${process.env.SMTP_USER}>`,
    to: recipient,
    subject,
    html,
    text,
  });
};

// (optional) export transporter if you use it elsewhere
export { transporter };
