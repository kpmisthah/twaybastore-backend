
import mongoose from "mongoose";
import dotenv from "dotenv";
import Product from "./models/Product.js";

dotenv.config();

async function testVariantEnrichment() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log("Connected to MongoDB");

        // Mock the logic from orderRoutes.js
        async function fixItems(items) {
            return await Promise.all(
                items.map(async (item) => {
                    if (!item.product) return item;

                    const product = await Product.findById(item.product).lean();
                    if (!product || !product.variants?.length)
                        return { ...item, color: item.color || "", dimensions: item.dimensions || "" };

                    let variant = null;
                    if (item.variantId) {
                        variant = product.variants.find(v => v._id?.toString() === item.variantId.toString());
                    }

                    if (!variant && (item.color || item.dimensions)) {
                        variant = product.variants.find(
                            (v) =>
                                (!item.color || v.color?.toLowerCase() === item.color.toLowerCase()) &&
                                (!item.dimensions || v.dimensions?.trim() === item.dimensions.trim())
                        );
                    }

                    if (!variant) variant = product.variants[0];

                    return {
                        ...item,
                        color: item.color || variant?.color || "",
                        dimensions: item.dimensions || variant?.dimensions || "",
                    };
                })
            );
        }

        // Test Case 1: Product with variants, no variant specified
        const productWithVariants = await Product.findOne({ "variants.0": { $exists: true } }).lean();
        if (productWithVariants) {
            console.log(`Testing with product: ${productWithVariants.name} (${productWithVariants._id})`);
            const items = [{ product: productWithVariants._id, qty: 1 }];
            const fixed = await fixItems(items);
            console.log("Test Case 1 (No variant specified):", JSON.stringify(fixed[0], null, 2));
            if (fixed[0].color && fixed[0].dimensions) {
                console.log("✅ Success: Populated with first variant.");
            } else {
                console.log("❌ Failure: Should have populated with first variant.");
            }
        }

        await mongoose.disconnect();
    } catch (err) {
        console.error(err);
    }
}

testVariantEnrichment();
