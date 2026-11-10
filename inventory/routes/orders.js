// inventory/routes/orders.js — orders, picking, deliveries and website-order problems.
// Admins/managers create and allocate orders; anyone who handles stock picks and returns.
import express from "express";
import { z } from "zod";
import { allow } from "../auth/auth.js";
import { DELIVERY, ORDER_READ, ORDER_WRITE, STOCK_WRITE } from "../auth/roles.js";
import { ah } from "../lib/http.js";
import { send } from "../lib/json.js";
import { idParam, parse, zId, zQueryInt } from "../lib/validate.js";
import { EXCEPTION_TYPES, IMPORT_ISSUE_STATUSES, ORDER_PAYMENTS, ORDER_STATUSES } from "../models/Order.js";
import { RETURN_CONDITIONS } from "../models/Sale.js";
import { assignDriver, deliverOrder, failDelivery, listDrivers, reportException, startDelivery } from "../services/deliveries.js";
import {
  allocateOrder,
  cancelOrder,
  createOrder,
  getOrder,
  listOrders,
  pickItem,
  returnScan,
  shortPick,
  suggestForOrder,
  unallocateOrder,
  updateOrder,
} from "../services/orders.js";
import { ignoreIssue, listIssues, retryIssue } from "../services/websiteOrders.js";

export const orderRoutes = express.Router();
export const websiteOrderRoutes = express.Router();

const money = z
  .number()
  .min(0)
  .max(1_000_000)
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, "At most 2 decimal places");
/** Delivery photos are uploaded through the app (POST /uploads/deliveries → Cloudinary). */
const photoUrl = z
  .string()
  .max(500)
  .regex(/^https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/.+\/twayba\/inventory\/deliveries\/[^/]+$/, "photo must be uploaded through the app");

const Details = z.object({
  customerPhone: z.string().max(30).optional(),
  address: z.string().max(500).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  notes: z.string().max(1000).optional(),
  paymentStatus: z.enum(ORDER_PAYMENTS).optional(),
  codAmount: money.optional(),
  deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}/, "Use YYYY-MM-DD").optional(),
  timeWindow: z.string().max(50).optional(),
});
const OrderLine = z.object({ variantId: zId, quantity: z.number().int().min(1).max(10000) });
const CreateOrder = Details.extend({
  customerName: z.string().trim().min(1).max(100),
  lines: z.array(OrderLine).min(1).max(200),
});
const UpdateOrder = Details.extend({ customerName: z.string().trim().min(1).max(100).optional() });
const Allocate = z.object({
  allocations: z
    .array(z.object({ lineId: zId, variantId: zId, locationId: zId, quantity: z.number().int().min(1).max(10000) }))
    .min(1)
    .max(1000),
});
const Approval = z.object({ login: z.string().trim().min(1).max(200), password: z.string().min(1).max(200) });
const Pick = z.object({
  /** What was scanned. */
  code: z.string().trim().min(1).max(100),
  /** Where the picker is standing. */
  locationId: zId,
  /** Taking it from a different place than allocated needs a manager. */
  approval: Approval.optional(),
  reason: z.string().max(300).optional(),
});
const ShortPick = z.object({ approval: Approval, reason: z.string().trim().min(1).max(300) });
const Reason = z.object({ reason: z.string().trim().min(1, "Give a reason").max(300) });
const ReturnScan = z.object({
  code: z.string().trim().min(1).max(100),
  condition: z.enum(RETURN_CONDITIONS),
  /** Where a good item goes back to. */
  locationId: zId.optional(),
});
const ListQuery = z.object({
  status: z.enum(ORDER_STATUSES).optional(),
  /** Only orders still to be done (new → out for delivery, and failed). */
  open: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  /** Delivered since this time (e.g. today's done list). */
  deliveredSince: z.string().refine((v) => !Number.isNaN(Date.parse(v)), "Invalid date").optional(),
  driverId: zId.optional(),
  q: z.string().max(100).optional(),
  page: zQueryInt(1, 100000).optional(),
  pageSize: zQueryInt(1, 100).optional(),
});
/** Required: send null explicitly to remove the driver (a missing field must not unassign). */
const AssignDriver = z.object({ driverId: zId.nullable() });
const Deliver = z.object({
  /** Only for a partial delivery: what the customer actually took. Omit = everything on the van. */
  items: z.array(OrderLine).max(500).optional(),
  /** Cash collected — required for cash-on-delivery orders. */
  codCollected: money.optional(),
  recipientName: z.string().max(100).optional(),
  note: z.string().max(1000).optional(),
  photoUrl: photoUrl.optional(),
  /** A partial delivery needs an admin/manager (unless one is delivering). */
  approval: Approval.optional(),
});
const FAIL_REASONS = ["NOT_HOME", "CUSTOMER_REFUSED", "WRONG_ADDRESS", "DAMAGED_BOX", "MISSING_BOX", "OTHER"];
const FailDelivery = z.object({ reason: z.enum(FAIL_REASONS), note: z.string().trim().min(1).max(1000), photoUrl: photoUrl.optional() });
const ReportException = z.object({
  type: z.enum(EXCEPTION_TYPES),
  variantId: zId.optional(),
  /** Responsible location (e.g. the space a damaged box came from). */
  locationId: zId.optional(),
  note: z.string().trim().min(1).max(1000),
  photoUrl: photoUrl.optional(),
});

const id = (req) => idParam(req.params.id);

/** Drivers always get only their own orders. */
orderRoutes.get(
  "/",
  allow(ORDER_READ),
  ah(async (req, res) => send(res, await listOrders(parse(ListQuery, req.query), req.staff)))
);
orderRoutes.get(
  "/drivers",
  allow(ORDER_WRITE),
  ah(async (req, res) => send(res, await listDrivers()))
);
orderRoutes.get(
  "/:id",
  allow(ORDER_READ),
  ah(async (req, res) => send(res, await getOrder(id(req), req.staff)))
);
orderRoutes.patch(
  "/:id/driver",
  allow(ORDER_WRITE),
  ah(async (req, res) => send(res, await assignDriver(req.staff, id(req), parse(AssignDriver, req.body).driverId)))
);
orderRoutes.post(
  "/:id/start",
  allow(DELIVERY),
  ah(async (req, res) => send(res, await startDelivery(req.staff, id(req))))
);
orderRoutes.post(
  "/:id/deliver",
  allow(DELIVERY),
  ah(async (req, res) => send(res, await deliverOrder(req.staff, id(req), parse(Deliver, req.body))))
);
orderRoutes.post(
  "/:id/fail",
  allow(DELIVERY),
  ah(async (req, res) => send(res, await failDelivery(req.staff, id(req), parse(FailDelivery, req.body))))
);
orderRoutes.post(
  "/:id/exceptions",
  allow(STOCK_WRITE),
  ah(async (req, res) => send(res, await reportException(req.staff, id(req), parse(ReportException, req.body)), 201))
);
orderRoutes.post(
  "/",
  allow(ORDER_WRITE),
  ah(async (req, res) => send(res, await createOrder(req.staff, parse(CreateOrder, req.body)), 201))
);
orderRoutes.patch(
  "/:id",
  allow(ORDER_WRITE),
  ah(async (req, res) => send(res, await updateOrder(req.staff, id(req), parse(UpdateOrder, req.body))))
);
orderRoutes.get(
  "/:id/suggestion",
  allow(ORDER_WRITE),
  ah(async (req, res) => send(res, await suggestForOrder(id(req))))
);
orderRoutes.post(
  "/:id/allocate",
  allow(ORDER_WRITE),
  ah(async (req, res) => send(res, await allocateOrder(req.staff, id(req), parse(Allocate, req.body))))
);
orderRoutes.post(
  "/:id/unallocate",
  allow(ORDER_WRITE),
  ah(async (req, res) => send(res, await unallocateOrder(req.staff, id(req))))
);
orderRoutes.post(
  "/:id/pick",
  allow(STOCK_WRITE),
  ah(async (req, res) => send(res, await pickItem(req.staff, id(req), parse(Pick, req.body))))
);
/** The approval inside the body is what authorises this; anyone picking can ask for it. */
orderRoutes.post(
  "/:id/short",
  allow(STOCK_WRITE),
  ah(async (req, res) => send(res, await shortPick(req.staff, id(req), parse(ShortPick, req.body))))
);
orderRoutes.post(
  "/:id/cancel",
  allow(ORDER_WRITE),
  ah(async (req, res) => send(res, await cancelOrder(req.staff, id(req), parse(Reason, req.body).reason)))
);
orderRoutes.post(
  "/:id/return-scan",
  allow(STOCK_WRITE),
  ah(async (req, res) => send(res, await returnScan(req.staff, id(req), parse(ReturnScan, req.body))))
);

// ------------------------------------------------------------------ website orders that could not be imported

websiteOrderRoutes.get(
  "/issues",
  allow(ORDER_WRITE),
  ah(async (req, res) => {
    const status = IMPORT_ISSUE_STATUSES.find((v) => v === req.query.status);
    send(res, await listIssues(status));
  })
);
websiteOrderRoutes.post(
  "/issues/:id/retry",
  allow(ORDER_WRITE),
  ah(async (req, res) => send(res, await retryIssue(req.staff, id(req))))
);
websiteOrderRoutes.post(
  "/issues/:id/ignore",
  allow(ORDER_WRITE),
  ah(async (req, res) => send(res, await ignoreIssue(req.staff, id(req))))
);

