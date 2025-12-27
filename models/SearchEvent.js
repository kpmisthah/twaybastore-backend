// models/SearchEvent.js
import mongoose from "mongoose";

const SearchEventSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    query: { type: String, trim: true },
    type: { type: String, enum: ["text", "voice"], default: "text" },
    availabilityTag: { type: String, enum: ["HAS_PRODUCT", "NO_PRODUCT"], index: true },
    count: { type: Number, default: 0 },
    pathname: String,
    ua: String,
    lang: String,
    confidence: Number,
    tookMs: Number,
    error: String,
    message: String,
    ip: String,
  },
  { timestamps: true }
);

SearchEventSchema.index({ createdAt: -1 });
SearchEventSchema.index({ query: "text" });

// Hot-reload safe + explicit collection name
export default mongoose.models.SearchEvent ||
  mongoose.model("SearchEvent", SearchEventSchema, "search_events");