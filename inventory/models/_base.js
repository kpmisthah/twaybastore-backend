// inventory/models/_base.js
import mongoose from "mongoose";

export const { Schema } = mongoose;
export const ObjectId = Schema.Types.ObjectId;

/** Reuses an already-compiled model (nodemon reloads, tests). */
export function model(name, schema, collection) {
  return mongoose.models[name] || mongoose.model(name, schema, collection);
}

/** Append-only collections: block every update and delete through Mongoose. */
export function appendOnly(schema, label) {
  const reject = function (next) {
    next(new Error(`${label} is append-only and cannot be changed or deleted`));
  };
  for (const op of [
    "updateOne",
    "updateMany",
    "findOneAndUpdate",
    "replaceOne",
    "findOneAndReplace",
    "deleteOne",
    "deleteMany",
    "findOneAndDelete",
  ]) {
    schema.pre(op, reject);
  }
  schema.pre("save", function (next) {
    if (!this.isNew) return reject(next);
    next();
  });
}

/** Unique index that ignores documents where the field is missing or null. */
export function uniqueWhenSet(schema, field) {
  schema.index({ [field]: 1 }, { unique: true, partialFilterExpression: { [field]: { $type: "string" } } });
}
