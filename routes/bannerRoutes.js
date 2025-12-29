import express from "express";
import Banner from "../models/Banner.js";
import { requireAdmin } from "../middleware/adminAuth.js";

const router = express.Router();

/**
 * @route   GET /api/banners
 * @desc    Get all active banners (for frontend display)
 * @access  Public
 */
router.get("/", async (req, res) => {
    try {
        const banners = await Banner.find({ isActive: true })
            .sort({ order: 1 })
            .select("-__v");

        res.json(banners);
    } catch (error) {
        console.error("Error fetching banners:", error);
        res.status(500).json({ message: "Failed to fetch banners" });
    }
});

/**
 * @route   GET /api/banners/admin/all
 * @desc    Get all banners including inactive (for admin panel)
 * @access  Admin only
 */
router.get("/admin/all", requireAdmin, async (req, res) => {
    try {
        const banners = await Banner.find().sort({ order: 1 });
        res.json(banners);
    } catch (error) {
        console.error("Error fetching all banners:", error);
        res.status(500).json({ message: "Failed to fetch banners" });
    }
});

/**
 * @route   POST /api/banners
 * @desc    Create a new banner
 * @access  Admin only
 */
router.post("/", requireAdmin, async (req, res) => {
    try {
        const { title, desktopImage, mobileImage, link, order, isActive } = req.body;

        // Validation
        if (!title || !desktopImage || !mobileImage) {
            return res.status(400).json({
                message: "Title, desktop image, and mobile image are required",
            });
        }

        const banner = new Banner({
            title,
            desktopImage,
            mobileImage,
            link: link || "/products",
            order: order !== undefined ? order : 0,
            isActive: isActive !== undefined ? isActive : true,
        });

        await banner.save();

        console.log(`✅ Banner created: ${banner.title} (ID: ${banner._id})`);
        res.status(201).json(banner);
    } catch (error) {
        console.error("Error creating banner:", error);
        res.status(400).json({ message: error.message });
    }
});

/**
 * @route   PUT /api/banners/:id
 * @desc    Update a banner
 * @access  Admin only
 */
router.put("/:id", requireAdmin, async (req, res) => {
    try {
        const { title, desktopImage, mobileImage, link, order, isActive } = req.body;

        const banner = await Banner.findByIdAndUpdate(
            req.params.id,
            {
                title,
                desktopImage,
                mobileImage,
                link,
                order,
                isActive,
            },
            { new: true, runValidators: true }
        );

        if (!banner) {
            return res.status(404).json({ message: "Banner not found" });
        }

        console.log(`✅ Banner updated: ${banner.title} (ID: ${banner._id})`);
        res.json(banner);
    } catch (error) {
        console.error("Error updating banner:", error);
        res.status(400).json({ message: error.message });
    }
});

/**
 * @route   DELETE /api/banners/:id
 * @desc    Delete a banner
 * @access  Admin only
 */
router.delete("/:id", requireAdmin, async (req, res) => {
    try {
        const banner = await Banner.findByIdAndDelete(req.params.id);

        if (!banner) {
            return res.status(404).json({ message: "Banner not found" });
        }

        console.log(`🗑️  Banner deleted: ${banner.title} (ID: ${banner._id})`);
        res.json({ message: "Banner deleted successfully", banner });
    } catch (error) {
        console.error("Error deleting banner:", error);
        res.status(500).json({ message: "Failed to delete banner" });
    }
});

/**
 * @route   PATCH /api/banners/:id/toggle
 * @desc    Toggle banner active status
 * @access  Admin only
 */
router.patch("/:id/toggle", requireAdmin, async (req, res) => {
    try {
        const banner = await Banner.findById(req.params.id);

        if (!banner) {
            return res.status(404).json({ message: "Banner not found" });
        }

        banner.isActive = !banner.isActive;
        await banner.save();

        console.log(
            `🔄 Banner ${banner.isActive ? "activated" : "deactivated"}: ${banner.title}`
        );
        res.json(banner);
    } catch (error) {
        console.error("Error toggling banner:", error);
        res.status(500).json({ message: "Failed to toggle banner status" });
    }
});

/**
 * @route   GET /api/banners/:id
 * @desc    Get single banner by ID
 * @access  Admin only
 */
router.get("/:id", requireAdmin, async (req, res) => {
    try {
        const banner = await Banner.findById(req.params.id);

        if (!banner) {
            return res.status(404).json({ message: "Banner not found" });
        }

        res.json(banner);
    } catch (error) {
        console.error("Error fetching banner:", error);
        res.status(500).json({ message: "Failed to fetch banner" });
    }
});

export default router;
