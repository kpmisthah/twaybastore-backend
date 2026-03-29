import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Product from '../models/Product.js';

dotenv.config({ path: '.env.development' });

async function analyze() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');

        const total = await Product.countDocuments();
        const withoutCode = await Product.countDocuments({
            $or: [
                { productCode: { $exists: false } },
                { productCode: '' },
                { productCode: null }
            ]
        });

        const withSkuButNoCode = await Product.countDocuments({
            sku: { $exists: true, $ne: '' },
            $or: [
                { productCode: { $exists: false } },
                { productCode: '' },
                { productCode: null }
            ]
        });

        console.log('--- Migration Analysis ---');
        console.log(`Total Products: ${total}`);
        console.log(`Products missing productCode: ${withoutCode}`);
        console.log(`Products with SKU but missing productCode: ${withSkuButNoCode}`);
        console.log('---------------------------');

        await mongoose.disconnect();
    } catch (err) {
        console.error('Analysis failed:', err);
    }
}

analyze();
