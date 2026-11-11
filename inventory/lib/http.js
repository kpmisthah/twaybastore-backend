// inventory/lib/http.js
// HTTP errors, async route wrapper and the inventory API's error handler.
import { ZodError } from "zod";

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const badRequest = (msg, extra) => new HttpError(400, msg, extra);
export const unauthorized = (msg = "Unauthorized") => new HttpError(401, msg);
export const forbidden = (msg = "You do not have permission for this action") => new HttpError(403, msg);
export const notFound = (msg = "Not found") => new HttpError(404, msg);
export const conflict = (msg, extra) => new HttpError(409, msg, extra);

/** Wraps an async route so thrown errors reach the error handler. */
export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Turns any thrown error into a JSON response: { message, ...extra }. */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ message: err.message, ...(err.extra || {}) });
  }
  if (err instanceof ZodError) {
    return res.status(400).json({ message: zodMessage(err) });
  }
  if (err?.name === "CastError") {
    return res.status(400).json({ message: `Invalid ${err.path || "id"}` });
  }
  if (err?.code === 11000) {
    return res.status(409).json({ message: "That value is already used by another record" });
  }
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({ message: "Invalid JSON body" });
  }
  console.error("[inventory]", err);
  return res.status(500).json({ message: "Something went wrong" });
}

export function zodMessage(err) {
  const issue = err.issues[0];
  if (!issue) return "Invalid request";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}
