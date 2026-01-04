import mongoose from "mongoose";

const bannerSchema = new mongoose.Schema(
    {
        title: {
            type: String,
            required: true,
            trim: true,
        },
        desktopImage: {
            type: String,
            required: true,
        },
        mobileImage: {
            type: String,
            required: true,
        },
        link: {
            type: String,
            default: "/products",
            trim: true,
        },
        isActive: {
            type: Boolean,
            default: true,
        },
        order: {
            type: Number,
            default: 0,
        },
    },
    {
        timestamps: true,
    }
);

// Index for efficient querying
bannerSchema.index({ isActive: 1, order: 1 });

export default mongoose.model("Banner", bannerSchema);
