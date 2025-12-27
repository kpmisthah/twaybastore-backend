// utils/uploadToCloudinary.js
import cloudinary from "./cloudinaryClient.js";

/**
 * Upload a file buffer to Cloudinary
 * @param {Object} file - Multer file object with buffer, mimetype, originalname
 * @returns {Promise<string>} - The secure URL of the uploaded image
 */
export const uploadToCloudinary = (file) => {
    return new Promise((resolve, reject) => {
        // Create upload stream
        const uploadStream = cloudinary.uploader.upload_stream(
            {
                folder: "twayba/products", // Organize images in folders
                resource_type: "auto", // Auto-detect file type (image, video, etc.)
                transformation: [
                    { quality: "auto:good" }, // Optimize quality automatically
                    { fetch_format: "auto" }, // Serve best format (webp, avif, etc.)
                ],
            },
            (error, result) => {
                if (error) {
                    console.error("Cloudinary upload error:", error);
                    reject(error);
                } else {
                    // Return the secure HTTPS URL
                    resolve(result.secure_url);
                }
            }
        );

        // Send the file buffer to Cloudinary
        uploadStream.end(file.buffer);
    });
};

/**
 * Delete an image from Cloudinary by URL
 * @param {string} imageUrl - The Cloudinary URL of the image
 */
export const deleteFromCloudinary = async (imageUrl) => {
    try {
        // Extract public_id from URL
        // URL format: https://res.cloudinary.com/CLOUD_NAME/image/upload/v1234/twayba/products/abc123.jpg
        const urlParts = imageUrl.split("/");
        const uploadIndex = urlParts.indexOf("upload");
        if (uploadIndex === -1) return;

        // Get everything after 'upload/vXXXXX/' and remove file extension
        const publicIdWithVersion = urlParts.slice(uploadIndex + 1).join("/");
        const publicId = publicIdWithVersion
            .replace(/^v\d+\//, "") // Remove version number
            .replace(/\.[^/.]+$/, ""); // Remove file extension

        await cloudinary.uploader.destroy(publicId);
        console.log(`✅ Deleted from Cloudinary: ${publicId}`);
    } catch (err) {
        console.error("Cloudinary delete error:", err.message);
    }
};
