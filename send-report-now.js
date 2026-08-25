import dotenv from "dotenv";
dotenv.config({ path: ".env" }); // Force loading the production environment variables

const triggerReport = async () => {
  // Use dynamic imports so they only load AFTER dotenv has populated process.env
  const mongoose = (await import("mongoose")).default;
  await import("./models/Product.js");
  const Order = (await import("./models/Order.js")).default;
  const { sendDailySalesReportEmail } = await import("./utils/mailer.js");

  try {
    console.log("Connecting to PRODUCTION MongoDB...");
    await mongoose.connect(process.env.MONGO_URI);
    
    // We want the business date for yesterday
    const businessDate = "2026-07-04";
    console.log(`Connected! Generating PRODUCTION report for business date: ${businessDate}...`);

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

    console.log("✅ PRODUCTION Daily Sales Report for " + businessDate + " sent successfully.");
    process.exit(0);
  } catch (err) {
    console.error("Failed to run report:", err);
    process.exit(1);
  }
};

triggerReport();
