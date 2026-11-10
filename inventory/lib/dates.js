// inventory/lib/dates.js — calendar days are Malta days, whatever timezone the server runs in.

export const TIMEZONE = "Europe/Malta";

/** Minutes Malta is ahead of UTC at the given instant (60 in winter, 120 in summer). */
function maltaOffsetMinutes(at) {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: TIMEZONE, timeZoneName: "shortOffset" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value; // "GMT+1"
  const m = /GMT([+-]\d+)(?::(\d+))?/.exec(name || "");
  return m ? Number(m[1]) * 60 + Math.sign(Number(m[1])) * Number(m[2] || 0) : 0;
}

/** Start of a Malta calendar day ("2026-10-30") as a UTC instant. */
export function maltaDayStart(day) {
  const utcMidnight = new Date(`${day}T00:00:00Z`);
  return new Date(utcMidnight.getTime() - maltaOffsetMinutes(utcMidnight) * 60_000);
}

/** Today's date in Malta as YYYY-MM-DD. */
export function maltaToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(now);
}

export function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Mongo filter for `from`..`to` inclusive (either may be missing). */
export function dayRange(from, to) {
  if (!from && !to) return undefined;
  const range = {};
  if (from) range.$gte = maltaDayStart(from);
  if (to) range.$lt = maltaDayStart(addDays(to, 1));
  return range;
}
