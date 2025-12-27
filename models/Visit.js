import mongoose from "mongoose";

const visitSchema = new mongoose.Schema({
  ip: String,
  userAgent: String,
  path: String, // 👈 store which route was visited
  timestamp: { type: Date, default: Date.now },
});

export default mongoose.model("Visit", visitSchema);
