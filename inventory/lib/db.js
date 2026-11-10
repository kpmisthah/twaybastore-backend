// inventory/lib/db.js
// Transactions and gap-free counters (MongoDB Atlas is a replica set, so transactions work).
import mongoose from "mongoose";
import Counter from "../models/Counter.js";

/**
 * Runs `fn(session)` in a transaction. MongoDB retries the whole function on transient
 * errors (e.g. a write conflict when two users touch the same stock row), so `fn` must
 * only write through the session and must be safe to run again.
 */
export async function withTransaction(fn) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

/**
 * Atomically increments a named counter and returns the new value. Inside a transaction the
 * number is only used if the transaction commits, so invoice numbers have no gaps.
 */
export async function nextCounter(name, session) {
  const row = await Counter.findOneAndUpdate(
    { _id: name },
    { $inc: { value: 1 } },
    { upsert: true, new: true, session }
  );
  return row.value;
}

/**
 * A named lock for the rest of the transaction, for records that can't be written to (invoices):
 * a second transaction taking the same key conflicts and is retried after the first commits.
 */
export async function lockKey(name, session) {
  await Counter.updateOne({ _id: `lock:${name}` }, { $inc: { value: 1 } }, { upsert: true, session });
}

/** Mongo duplicate-key error, optionally on a given field. */
export function isDuplicateKey(err, field) {
  if (err?.code !== 11000) return false;
  return !field || Object.keys(err.keyPattern || {}).includes(field);
}
