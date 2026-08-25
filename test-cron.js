import cron from "node-cron";
cron.schedule("* * * * *", () => {
  console.log("Cron triggered!");
}, {
  scheduled: true,
  timezone: "Europe/Malta"
});
console.log("Cron initialized. Waiting 65s...");
setTimeout(() => {
  console.log("Done waiting.");
  process.exit(0);
}, 65000);
