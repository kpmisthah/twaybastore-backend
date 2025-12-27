import express from "express";
import { upload } from "../middleware/upload.js";
// Switched from R2 to Cloudinary (free tier)
import { uploadToCloudinary } from "../utils/uploadToCloudinary.js";

const router = express.Router();

router.post("/product-image", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded" });
    }

    // Upload to Cloudinary instead of R2
    const url = await uploadToCloudinary(req.file);
    res.json({ url });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ message: "Image upload failed" });
  }
});

export default router;
