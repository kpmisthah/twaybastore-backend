// inventory/services/movementRules.js — what each movement type may do (pure functions).

/** Which locations each movement type takes. ADJUSTMENT takes exactly one (in or out). */
const SHAPE = {
  STOCK_IN: { from: "forbidden", to: "required" },
  STOCK_OUT: { from: "required", to: "forbidden" },
  TRANSFER: { from: "required", to: "required" },
  ADJUSTMENT: { from: "optional", to: "optional" },
  RESERVE: { from: "required", to: "forbidden" },
  RELEASE: { from: "required", to: "forbidden" },
  LOAD: { from: "required", to: "required" },
  DELIVER: { from: "required", to: "forbidden" },
  RETURN: { from: "optional", to: "required" },
  SALE: { from: "required", to: "forbidden" },
  SALE_RETURN: { from: "forbidden", to: "required" },
  DAMAGE: { from: "required", to: "required" },
  TRANSFER_OUT: { from: "required", to: "required" },
  TRANSFER_IN: { from: "required", to: "required" },
};

export const MOVEMENT_LABELS = {
  STOCK_IN: "Stock in",
  STOCK_OUT: "Stock out",
  TRANSFER: "Transfer",
  ADJUSTMENT: "Adjustment",
  RESERVE: "Reserve",
  RELEASE: "Release",
  LOAD: "Load",
  DELIVER: "Deliver",
  RETURN: "Return",
  SALE: "Sale",
  SALE_RETURN: "Sale return",
  DAMAGE: "Damage",
  TRANSFER_OUT: "Sent (transfer)",
  TRANSFER_IN: "Received (transfer)",
};

const label = (type) => MOVEMENT_LABELS[type];

/** Throws a readable message if the movement is malformed. m: { type, quantity, fromLocationId, toLocationId } */
export function assertShape(m) {
  if (!Number.isInteger(m.quantity) || m.quantity <= 0) throw new Error("Quantity must be a whole number above 0");
  const shape = SHAPE[m.type];
  if (!shape) throw new Error(`Unknown movement type ${m.type}`);
  const check = (need, value, side) => {
    if (need === "required" && !value) throw new Error(`${label(m.type)} needs a "${side}" location`);
    if (need === "forbidden" && value) throw new Error(`${label(m.type)} can't have a "${side}" location`);
  };
  check(shape.from, m.fromLocationId, "from");
  check(shape.to, m.toLocationId, "to");
  if (m.type === "ADJUSTMENT" && !m.fromLocationId === !m.toLocationId) {
    throw new Error("An adjustment is either in (to a location) or out (from a location)");
  }
  if (m.fromLocationId && String(m.fromLocationId) === String(m.toLocationId)) {
    throw new Error('"From" and "to" are the same location');
  }
}

/** What the movement does to stock rows: [{ locationId, onHand, reserved }]. LOAD uses up the reservation it was made against. */
export function effectsOf(m) {
  const q = m.quantity;
  const out = [];
  const from = m.fromLocationId ? String(m.fromLocationId) : null;
  const to = m.toLocationId ? String(m.toLocationId) : null;

  switch (m.type) {
    case "RESERVE":
      return [{ locationId: from, onHand: 0, reserved: q }];
    case "RELEASE":
      return [{ locationId: from, onHand: 0, reserved: -q }];
    case "LOAD":
      out.push({ locationId: from, onHand: -q, reserved: -q });
      break;
    default:
      if (from) out.push({ locationId: from, onHand: -q, reserved: 0 });
  }
  if (to) out.push({ locationId: to, onHand: q, reserved: 0 });
  return out;
}

/**
 * System locations only take part in their own steps:
 * In Transit is entered by LOAD (orders) or TRANSFER_OUT (two-step transfers), and left by
 * DELIVER / RETURN / TRANSFER_IN — or an ADJUSTMENT writing off a transfer that never arrived;
 * Damaged is entered by DAMAGE or a damaged return, and can be cleared out or corrected.
 * Returns an error message, or null if allowed.
 */
export function systemLocationError(type, fromType, toType) {
  const transitIn = ["LOAD", "TRANSFER_OUT"];
  const transitOut = ["DELIVER", "RETURN", "TRANSFER_IN", "ADJUSTMENT"];
  if (type === "TRANSFER_IN" && fromType !== "TRANSIT") return "A transfer is received from In Transit";
  const damagedIn = ["DAMAGE", "RETURN", "SALE_RETURN", "ADJUSTMENT"];
  const damagedOut = ["STOCK_OUT", "TRANSFER", "ADJUSTMENT"];

  if ((toType === "TRANSIT") !== transitIn.includes(type)) {
    return toType === "TRANSIT" ? "Stock goes into In Transit only by loading an order" : `${label(type)} must go to In Transit`;
  }
  if (type === "DELIVER" && fromType !== "TRANSIT") return "Only stock In Transit can be delivered";
  if (fromType === "TRANSIT" && !transitOut.includes(type)) {
    return "Stock leaves In Transit only by delivering, returning or receiving it";
  }
  if (type === "DAMAGE" && toType !== "DAMAGED") return "Damaged stock must go to the Damaged location";
  if (toType === "DAMAGED" && !damagedIn.includes(type)) return 'Use "Mark damaged" to move stock to Damaged';
  if (fromType === "DAMAGED" && !damagedOut.includes(type)) return "Damaged stock can only be removed, moved or corrected";
  return null;
}

/** Stock rows must stay 0 ≤ reserved ≤ onHand. */
export function isValidLevel(level) {
  return level.onHand >= 0 && level.reserved >= 0 && level.reserved <= level.onHand;
}

// ------------------------------------------------------------------ reasons

/** Fixed reason lists. "Other" needs a note explaining it. */
export const ADD_REASONS = ["New purchase", "Return", "Found", "Other"];
/** "Damaged" is not here: damaged stock is a DAMAGE movement to the Damaged location. */
export const REMOVE_REASONS = ["Lost", "Expired", "Manual adjustment", "Other"];
export const OTHER = "Other";

/** Returns an error message, or null if the reason/note combination is fine. */
export function reasonError(type, reason, note) {
  const r = reason?.trim();
  const list = type === "STOCK_IN" ? ADD_REASONS : type === "STOCK_OUT" ? REMOVE_REASONS : null;

  if (list) {
    if (!r) return "Choose a reason";
    if (!list.includes(r)) return `Reason must be one of: ${list.join(", ")}`;
  }
  if ((type === "ADJUSTMENT" || type === "DAMAGE") && !r && !note?.trim()) {
    return type === "DAMAGE" ? "Describe the damage" : "Give a reason for the correction";
  }
  if (r === OTHER && !note?.trim()) return 'Add a note explaining "Other"';
  return null;
}

// ------------------------------------------------------------------ kits

/**
 * Sellable kits = the smallest "available ÷ needed" over all boxes.
 * Leftover boxes that can't make a full kit are "spare" (reported as incomplete kits).
 * 10 × A, 10 × B, 7 × C (1 each) → 7 sellable; 3 A and 3 B spare.
 * boxes: [{ variantId, perKit, available }]
 */
export function kitAvailability(boxes) {
  const sellable = boxes.length ? Math.max(0, Math.min(...boxes.map((b) => Math.floor(b.available / b.perKit)))) : 0;
  return {
    sellable,
    boxes: boxes.map((b) => ({ ...b, spare: Math.max(0, b.available - sellable * b.perKit) })),
  };
}
