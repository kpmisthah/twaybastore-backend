// inventory/services/deliveries.js
// The driver's side of an order: assign → out for delivery → delivered (the second scan /
// confirmation, stock leaves In Transit) or failed (stays In Transit), plus problem reports.
import { verifyApprover } from "../auth/approver.js";
import { APPROVER_ROLES } from "../auth/roles.js";
import { withTransaction } from "../lib/db.js";
import { badRequest, notFound } from "../lib/http.js";
import Location from "../models/Location.js";
import { Order } from "../models/Order.js";
import User from "../models/User.js";
import { audit } from "./audit.js";
import { getOrder, inTransitOf, lockOrder } from "./orders.js";
import { systemLocationId } from "./locations.js";
import { applyMoves } from "./stock.js";

const s = (v) => (v == null ? v : String(v));
/** Can't change the driver once the order is finished. */
const FINISHED = ["DELIVERED", "RETURNED", "CANCELLED"];
const DELIVERABLE = ["LOADED", "OUT_FOR_DELIVERY"];

/** Active users with the Driver role, for the "assign driver" list. */
export async function listDrivers() {
  const rows = await User.find({ role: "DRIVER", active: true }).select("name phone").sort({ name: 1 }).lean();
  return rows.map((u) => ({ id: s(u._id), name: u.name, phone: u.phone ?? null }));
}

export async function assignDriver(user, id, driverId) {
  const order = await Order.findById(id).lean();
  if (!order) throw notFound("Order not found");
  if (FINISHED.includes(order.status)) throw badRequest(`${order.orderNumber} is ${order.status.toLowerCase()}`);
  if (driverId) {
    const driver = await User.findById(driverId).lean();
    if (!driver || !driver.active || driver.role !== "DRIVER") throw badRequest("Choose an active driver");
  }
  await Order.updateOne({ _id: id }, { $set: { driverId: driverId ?? null } });
  await audit({ userId: user.id, action: "ORDER_DRIVER_ASSIGNED", entity: "Order", entityId: id, data: { orderNumber: order.orderNumber, driverId: driverId ?? null } });
  return getOrder(id);
}

/** The driver sets off (also used for a second attempt after a failed delivery). */
export async function startDelivery(user, id) {
  await withTransaction(async (session) => {
    const order = await lockOrder(session, id, user);
    if (order.status !== "LOADED" && order.status !== "FAILED") {
      throw badRequest(`${order.orderNumber} is ${order.status.toLowerCase()} — load it first`);
    }
    if (!order.allocations.some((a) => inTransitOf(a) > 0)) throw badRequest("Nothing is on the van for this order");
    await Order.updateOne({ _id: id }, { $set: { status: "OUT_FOR_DELIVERY", startedAt: new Date(), failedReason: null } }, { session });
    await audit(
      { userId: user.id, action: "DELIVERY_STARTED", entity: "Order", entityId: id, data: { orderNumber: order.orderNumber, retry: order.status === "FAILED" } },
      session
    );
  });
  return getOrder(id, user);
}

/**
 * Delivered: everything on the van leaves stock (DELIVER movements). For a partial delivery the
 * driver lists what the customer took; that needs an admin/manager, and the rest stays In
 * Transit until scanned back in.
 * dto: { items?: [{ variantId, quantity }], codCollected?, recipientName?, note?, photoUrl?, approval? }
 */
export async function deliverOrder(user, id, dto) {
  // Checked up front (bcrypt is slow, and a retried transaction would repeat it); used only if partial.
  const approval = dto.approval && !APPROVER_ROLES.includes(user.role) ? await verifyApprover(dto.approval).catch((e) => e) : null;

  await withTransaction(async (session) => {
    const order = await lockOrder(session, id, user);
    if (!DELIVERABLE.includes(order.status)) throw badRequest(`${order.orderNumber} is ${order.status.toLowerCase()} — it can't be delivered now`);

    const onVan = new Map();
    for (const a of order.allocations) onVan.set(s(a.variantId), (onVan.get(s(a.variantId)) ?? 0) + inTransitOf(a));
    const totalOnVan = [...onVan.values()].reduce((t, n) => t + n, 0);
    if (totalOnVan === 0) throw badRequest("Nothing is on the van for this order");

    // What is being handed over, per item.
    const handing = new Map();
    if (dto.items?.length) {
      for (const i of dto.items) handing.set(i.variantId, (handing.get(i.variantId) ?? 0) + i.quantity);
      for (const [variantId, n] of handing) {
        if (n > (onVan.get(variantId) ?? 0)) throw badRequest(`Only ${onVan.get(variantId) ?? 0} of that item are on the van`);
      }
    } else {
      for (const [variantId, n] of onVan) if (n > 0) handing.set(variantId, n);
    }
    const handed = [...handing.values()].reduce((t, n) => t + n, 0);
    if (handed === 0) throw badRequest("Nothing selected to deliver");
    const partial = handed < totalOnVan;

    let partialApprovedById = null;
    if (partial) {
      if (APPROVER_ROLES.includes(user.role)) partialApprovedById = user.id;
      else if (approval instanceof Error) throw approval;
      else if (approval) partialApprovedById = approval;
      else throw badRequest("Delivering only part of the order needs a manager’s approval");
      if (!dto.note?.trim()) throw badRequest("Say why only part of the order was delivered");
    }
    if (order.paymentStatus === "COD" && dto.codCollected === undefined) {
      throw badRequest("Enter the cash collected for this cash-on-delivery order");
    }

    // Spread the delivered units over the allocations they were loaded from.
    const left = new Map(handing);
    const allocations = order.allocations.map((a) => {
      const want = left.get(s(a.variantId)) ?? 0;
      const take = Math.min(want, inTransitOf(a));
      if (take <= 0) return a;
      left.set(s(a.variantId), want - take);
      return { ...a, delivered: a.delivered + take };
    });
    const transitId = await systemLocationId("TRANSIT", session);
    await applyMoves(
      user.id,
      [...handing].map(([variantId, quantity]) => ({ type: "DELIVER", variantId, quantity, fromLocationId: transitId, reference: order.orderNumber })),
      session
    );

    await Order.updateOne(
      { _id: id },
      {
        $set: {
          allocations,
          status: "DELIVERED",
          deliveredAt: new Date(),
          deliveredById: user.id,
          recipientName: dto.recipientName?.trim() || null,
          codCollected: dto.codCollected ?? null,
          deliveryNote: dto.note?.trim() || null,
          deliveryPhotoUrl: dto.photoUrl ?? null,
          partialApprovedById,
        },
      },
      { session }
    );
    await audit(
      {
        userId: user.id,
        action: partial ? "ORDER_DELIVERED_PARTIAL" : "ORDER_DELIVERED",
        entity: "Order",
        entityId: id,
        data: {
          orderNumber: order.orderNumber,
          delivered: handed,
          notDelivered: totalOnVan - handed,
          codExpected: order.codAmount ?? null,
          codCollected: dto.codCollected ?? null,
          partialApprovedById,
        },
      },
      session
    );
  });
  return getOrder(id, user);
}

/** Couldn't deliver: the goods stay In Transit until delivered again or scanned back in. dto: { reason, note, photoUrl? } */
export async function failDelivery(user, id, dto) {
  await withTransaction(async (session) => {
    const order = await lockOrder(session, id, user);
    if (!DELIVERABLE.includes(order.status)) throw badRequest(`${order.orderNumber} is ${order.status.toLowerCase()}`);
    await Order.updateOne(
      { _id: id },
      {
        $set: { status: "FAILED", failedReason: dto.reason },
        $push: { exceptions: { type: dto.reason, note: dto.note.trim(), photoUrl: dto.photoUrl ?? null, reportedById: user.id } },
      },
      { session }
    );
    await audit(
      { userId: user.id, action: "DELIVERY_FAILED", entity: "Order", entityId: id, data: { orderNumber: order.orderNumber, reason: dto.reason, note: dto.note } },
      session
    );
  });
  return getOrder(id, user);
}

/** Missing / damaged box or any other problem, with notes and an optional photo. dto: { type, variantId?, locationId?, note, photoUrl? } */
export async function reportException(user, id, dto) {
  const order = await getOrder(id, user);
  if (dto.variantId && !order.allocations.some((a) => a.variantId === dto.variantId)) throw badRequest("That item is not on this order");
  if (dto.locationId && !(await Location.exists({ _id: dto.locationId }))) throw badRequest("Location not found");
  await Order.updateOne(
    { _id: id },
    {
      $push: {
        exceptions: {
          type: dto.type,
          variantId: dto.variantId ?? null,
          locationId: dto.locationId ?? null,
          note: dto.note.trim(),
          photoUrl: dto.photoUrl ?? null,
          reportedById: user.id,
        },
      },
    }
  );
  await audit({ userId: user.id, action: "DELIVERY_EXCEPTION", entity: "Order", entityId: id, data: { orderNumber: order.orderNumber, type: dto.type, note: dto.note } });
  return getOrder(id, user);
}
