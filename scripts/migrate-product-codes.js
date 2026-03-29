import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Product from '../models/Product.js';

const envFile = process.argv[2] === 'prod' ? '.env' : '.env.development';
dotenv.config({ path: envFile });
console.log(`Using environment file: ${envFile}`);

async function migrate() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');

        const products = await Product.find({
            $or: [
                { productCode: { $exists: false } },
                { productCode: '' },
                { productCode: null }
            ]
        });

        console.log(`Found ${products.length} products to migrate.`);

        let migratedCount = 0;
        for (const prod of products) {
            // Logic: 
            // 1. If SKU exists and is non-empty, use SKU as productCode
            // 2. If no SKU, generate one using a prefix + last 6 chars of ID
            let newCode = prod.sku;

            if (!newCode || newCode.trim() === '') {
                const shortId = prod._id.toString().slice(-6).toUpperCase();
                newCode = `PROD-${shortId}`;
            }

            // Ensure uniqueness check (simple check before update)
            const existing = await Product.findOne({ productCode: newCode });
            if (existing && existing._id.toString() !== prod._id.toString()) {
                // If collision, append more of the ID
                newCode = `PROD-${prod._id.toString().slice(-10).toUpperCase()}`;
            }

            prod.productCode = newCode;
            await prod.save();
            console.log(`Updated: ${prod.name} -> ${newCode}`);
            migratedCount++;
        }

        console.log(`Migration complete. Updated ${migratedCount} products.`);
        await mongoose.disconnect();
    } catch (err) {
        console.error('Migration failed:', err);
    }
}

migrate();
