// utils/cronJobs.js
import cron from "node-cron";
import Order from "../models/Order.js";
import { getMaltaBusinessDate } from "./businessDate.js";
import { sendDailySalesReportEmail } from "./mailer.js";

export const runDailySalesReport = async () => {
  try {
    console.log("⏰ Running Daily Sales Report...");

    const businessDate = getMaltaBusinessDate(new Date());

    const orders = await Order.find({
      businessDate,
      status: { $ne: "Cancelled" }
    }).sort({ createdAt: 1 }).populate("items.product", "name");

    let summary = { website: 0, shop: 0, wolt: 0, total: 0 };

    orders.forEach(order => {
      const amount = order.finalTotal || order.total || 0;
      if (order.channel === 'website') summary.website += amount;
      else if (order.channel === 'shop') summary.shop += amount;
      else if (order.channel === 'wolt') summary.wolt += amount;

      summary.total += amount;
    });

    await sendDailySalesReportEmail({
      businessDate,
      summary,
      orders
    });

    console.log("✅ Daily Sales Report sent successfully.");
  } catch (err) {
    console.error("❌ Error sending Daily Sales Report:", err);
  }
};

export const initCronJobs = () => {
  // Run every day at 19:14 (7:14 PM) Malta time, right before it resets at 19:15
  cron.schedule("14 19 * * *", runDailySalesReport, {
    scheduled: true,
    timezone: "Europe/Malta"
  });

  console.log("📅 Cron jobs initialized (Daily Sales Report at 19:14 Malta Time).");
};
