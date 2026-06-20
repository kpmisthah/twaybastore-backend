// utils/businessDate.js

/**
 * Calculates the custom business date string for revenue tracking.
 * Malta Timezone (CET/CEST): Europe/Malta.
 * Rule: If the time is >= 19:15 (7:15 PM) in Malta, it counts towards the NEXT business day.
 * Returns a YYYY-MM-DD string representing the business date.
 */
export function getMaltaBusinessDate(dateObj = new Date()) {
  // Convert the Date to Malta time
  const maltaTimeString = dateObj.toLocaleString("en-US", {
    timeZone: "Europe/Malta",
  });
  const maltaDate = new Date(maltaTimeString);

  // Extract components
  const year = maltaDate.getFullYear();
  const month = maltaDate.getMonth();
  const date = maltaDate.getDate();
  const hours = maltaDate.getHours();
  const minutes = maltaDate.getMinutes();

  // If >= 19:15 (7:15 PM), add 1 day
  if (hours > 19 || (hours === 19 && minutes >= 15)) {
    maltaDate.setDate(maltaDate.getDate() + 1);
  }

  // Return formatted YYYY-MM-DD
  const finalYear = maltaDate.getFullYear();
  const finalMonth = String(maltaDate.getMonth() + 1).padStart(2, "0");
  const finalDay = String(maltaDate.getDate()).padStart(2, "0");

  return `${finalYear}-${finalMonth}-${finalDay}`;
}
