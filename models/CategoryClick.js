import mongoose from "mongoose";

const categoryClickSchema = new mongoose.Schema({
  category: { type: String, required: true, unique: true },
  count: { type: Number, default: 0 },
});

export default mongoose.model("CategoryClick", categoryClickSchema);
