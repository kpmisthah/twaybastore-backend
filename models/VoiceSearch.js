// models/VoiceSearch.js
import mongoose from "mongoose";

const VoiceSearchSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    transcript: { type: String, trim: true },
    confidence: { type: Number, min: 0, max: 1 },
    lang: { type: String, default: "en-US" },
    source: { type: String, default: "navbar", index: true }, // where in UI
    pathname: { type: String },     // page path
    ua: { type: String },           // user agent
    tookMs: { type: Number },       // speech duration
    error: { type: String },        // if any recognition error
    message: { type: String },      // error detail
    ip: { type: String },
  },
  { timestamps: true }
);

// Helpful indexes
VoiceSearchSchema.index({ createdAt: -1 });
VoiceSearchSchema.index({ transcript: "text" });

// ✅ Hot-reload safe export (prevents OverwriteModelError)
export default mongoose.models.VoiceSearch ||
  mongoose.model("VoiceSearch", VoiceSearchSchema);
// If you want a custom collection name, use:
// mongoose.model("VoiceSearch", VoiceSearchSchema, "voice_searches");