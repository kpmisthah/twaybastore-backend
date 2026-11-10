// inventory/services/pricing.js
// POS money maths in whole cents (never floating-point euros). Percentages are handled in
// hundredths of a percent, so 7.5% VAT or 12.25% discount are exact.

const basisPoints = (percent) => Math.round(percent * 100);

export const toCents = (amount) => Math.round(Number(amount) * 100);
export const fromCents = (cents) => (cents / 100).toFixed(2);

/** line: { unitCents, quantity, discountPercent, taxRate } → { grossCents, discountCents, netCents, taxCents, totalCents } */
export function priceLine(line, pricesIncludeTax) {
  const grossCents = line.unitCents * line.quantity;
  const discountCents = Math.round((grossCents * basisPoints(line.discountPercent)) / 10_000);
  const afterDiscount = grossCents - discountCents;
  const rate = basisPoints(line.taxRate);

  if (pricesIncludeTax) {
    const taxCents = Math.round((afterDiscount * rate) / (10_000 + rate));
    return { grossCents, discountCents, netCents: afterDiscount - taxCents, taxCents, totalCents: afterDiscount };
  }
  const taxCents = Math.round((afterDiscount * rate) / 10_000);
  return { grossCents, discountCents, netCents: afterDiscount, taxCents, totalCents: afterDiscount + taxCents };
}

export function sumLines(lines) {
  return lines.reduce(
    (t, l) => ({
      grossCents: t.grossCents + l.grossCents,
      discountCents: t.discountCents + l.discountCents,
      netCents: t.netCents + l.netCents,
      taxCents: t.taxCents + l.taxCents,
      totalCents: t.totalCents + l.totalCents,
    }),
    { grossCents: 0, discountCents: 0, netCents: 0, taxCents: 0, totalCents: 0 }
  );
}

/** Payments must cover the total; only cash can be more than what's due (the rest is change). payments: [{ method, cents }] */
export function settle(totalCents, payments) {
  if (payments.some((p) => !Number.isInteger(p.cents) || p.cents <= 0)) throw new Error("Each payment must be more than 0");
  const paidCents = payments.reduce((sum, p) => sum + p.cents, 0);
  if (paidCents < totalCents) throw new Error(`${fromCents(totalCents - paidCents)} still to pay`);
  const changeCents = paidCents - totalCents;
  const cashCents = payments.filter((p) => p.method === "CASH").reduce((sum, p) => sum + p.cents, 0);
  if (changeCents > cashCents) throw new Error("Only cash can be more than the amount due");
  return { paidCents, changeCents };
}

/**
 * Checks that the stock taken matches what is sold. A kit needs exactly quantity × per-kit of
 * every box — "A, A, A" never completes an A + B + C kit. Returns an error message, or null.
 * line: { name, kind: "STANDARD"|"KIT", variantId, quantity, boxes: [{ variantId, name, perKit }] }
 */
export function pickProblem(line, picks) {
  const taken = new Map();
  for (const p of picks) taken.set(p.variantId, (taken.get(p.variantId) ?? 0) + p.quantity);

  if (line.kind === "STANDARD") {
    if ([...taken.keys()].some((id) => id !== line.variantId)) return `${line.name}: a different item was picked`;
    const total = taken.get(line.variantId) ?? 0;
    return total === line.quantity ? null : `${line.name}: ${line.quantity} sold but ${total} taken from spaces`;
  }

  const boxIds = new Set(line.boxes.map((b) => b.variantId));
  if ([...taken.keys()].some((id) => !boxIds.has(id))) return `${line.name}: a scanned box is not part of this kit`;
  // Missing boxes first: that's what the cashier needs to go and find.
  for (const box of line.boxes) {
    const needed = box.perKit * line.quantity;
    const got = taken.get(box.variantId) ?? 0;
    if (got < needed) return `${line.name}: ${box.name} missing (${got} of ${needed} scanned)`;
  }
  for (const box of line.boxes) {
    const needed = box.perKit * line.quantity;
    const got = taken.get(box.variantId) ?? 0;
    if (got > needed) return `${line.name}: too many of ${box.name} (${got} scanned, kit needs ${needed})`;
  }
  return null;
}
