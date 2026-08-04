import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { Category, Product } from '../models';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/ppob';

const categories = [
    { name: 'Pulsa', slug: 'pulsa', icon: '📱', sortOrder: 1, status: true },
    { name: 'Paket Data', slug: 'paket-data', icon: '📡', sortOrder: 2, status: true },
    { name: 'Token PLN', slug: 'token-pln', icon: '⚡', sortOrder: 3, status: true },
    { name: 'E-Wallet', slug: 'e-wallet', icon: '💳', sortOrder: 4, status: true },
    { name: 'Voucher Game', slug: 'voucher-game', icon: '🎮', sortOrder: 5, status: true },
    { name: 'TV & Streaming', slug: 'tv-streaming', icon: '📺', sortOrder: 6, status: true },
];

const productTemplates = [
    // Pulsa
    { category: 'Pulsa', brand: 'Telkomsel', items: [
        { name: 'Pulsa Telkomsel 5.000', code: 'TSEL5', costPrice: 5200, basic: 5500, gold: 5400, platinum: 5300 },
        { name: 'Pulsa Telkomsel 10.000', code: 'TSEL10', costPrice: 10200, basic: 10500, gold: 10400, platinum: 10300 },
        { name: 'Pulsa Telkomsel 25.000', code: 'TSEL25', costPrice: 25100, basic: 25500, gold: 25400, platinum: 25200 },
        { name: 'Pulsa Telkomsel 50.000', code: 'TSEL50', costPrice: 49500, basic: 50500, gold: 50200, platinum: 50000 },
    ]},
    { category: 'Pulsa', brand: 'Indosat', items: [
        { name: 'Pulsa Indosat 5.000', code: 'ISAT5', costPrice: 5100, basic: 5400, gold: 5300, platinum: 5200 },
        { name: 'Pulsa Indosat 10.000', code: 'ISAT10', costPrice: 10100, basic: 10400, gold: 10300, platinum: 10200 },
        { name: 'Pulsa Indosat 25.000', code: 'ISAT25', costPrice: 24800, basic: 25400, gold: 25200, platinum: 25000 },
    ]},
    { category: 'Pulsa', brand: 'XL', items: [
        { name: 'Pulsa XL 5.000', code: 'XL5', costPrice: 5150, basic: 5450, gold: 5350, platinum: 5250 },
        { name: 'Pulsa XL 10.000', code: 'XL10', costPrice: 10150, basic: 10450, gold: 10350, platinum: 10250 },
    ]},

    // Paket Data
    { category: 'Paket Data', brand: 'Telkomsel', items: [
        { name: 'Paket Data 1GB 7 Hari', code: 'TSEL-DATA1', costPrice: 12000, basic: 14000, gold: 13500, platinum: 13000 },
        { name: 'Paket Data 3GB 30 Hari', code: 'TSEL-DATA3', costPrice: 28000, basic: 32000, gold: 31000, platinum: 30000 },
        { name: 'Paket Data 10GB 30 Hari', code: 'TSEL-DATA10', costPrice: 65000, basic: 72000, gold: 70000, platinum: 68000 },
    ]},
    { category: 'Paket Data', brand: 'Indosat', items: [
        { name: 'Freedom 2GB', code: 'ISAT-FREE2', costPrice: 18000, basic: 22000, gold: 21000, platinum: 20000 },
        { name: 'Freedom 5GB', code: 'ISAT-FREE5', costPrice: 35000, basic: 42000, gold: 40000, platinum: 38000 },
    ]},

    // Token PLN
    { category: 'Token PLN', brand: 'PLN', items: [
        { name: 'Token PLN 20.000', code: 'PLN20', costPrice: 20000, basic: 21500, gold: 21000, platinum: 20500 },
        { name: 'Token PLN 50.000', code: 'PLN50', costPrice: 50000, basic: 51500, gold: 51000, platinum: 50500 },
        { name: 'Token PLN 100.000', code: 'PLN100', costPrice: 100000, basic: 102000, gold: 101500, platinum: 101000 },
        { name: 'Token PLN 200.000', code: 'PLN200', costPrice: 200000, basic: 203000, gold: 202000, platinum: 201000 },
    ]},

    // E-Wallet
    { category: 'E-Wallet', brand: 'GoPay', items: [
        { name: 'GoPay 20.000', code: 'GOPAY20', costPrice: 20000, basic: 21000, gold: 20800, platinum: 20500 },
        { name: 'GoPay 50.000', code: 'GOPAY50', costPrice: 50000, basic: 51500, gold: 51000, platinum: 50800 },
        { name: 'GoPay 100.000', code: 'GOPAY100', costPrice: 100000, basic: 102000, gold: 101500, platinum: 101000 },
    ]},
    { category: 'E-Wallet', brand: 'OVO', items: [
        { name: 'OVO 25.000', code: 'OVO25', costPrice: 25000, basic: 26000, gold: 25800, platinum: 25500 },
        { name: 'OVO 50.000', code: 'OVO50', costPrice: 50000, basic: 51500, gold: 51000, platinum: 50800 },
    ]},
    { category: 'E-Wallet', brand: 'DANA', items: [
        { name: 'DANA 25.000', code: 'DANA25', costPrice: 25000, basic: 26000, gold: 25800, platinum: 25500 },
        { name: 'DANA 50.000', code: 'DANA50', costPrice: 50000, basic: 51500, gold: 51000, platinum: 50800 },
    ]},

    // Voucher Game
    { category: 'Voucher Game', brand: 'Mobile Legends', items: [
        { name: 'ML 86 Diamonds', code: 'ML86', costPrice: 19000, basic: 22000, gold: 21500, platinum: 21000 },
        { name: 'ML 172 Diamonds', code: 'ML172', costPrice: 38000, basic: 44000, gold: 43000, platinum: 42000 },
        { name: 'ML 344 Diamonds', code: 'ML344', costPrice: 76000, basic: 88000, gold: 86000, platinum: 84000 },
    ]},
    { category: 'Voucher Game', brand: 'Free Fire', items: [
        { name: 'FF 70 Diamonds', code: 'FF70', costPrice: 9500, basic: 11000, gold: 10800, platinum: 10500 },
        { name: 'FF 140 Diamonds', code: 'FF140', costPrice: 19000, basic: 22000, gold: 21500, platinum: 21000 },
    ]},
    { category: 'Voucher Game', brand: 'PUBG Mobile', items: [
        { name: 'PUBG 60 UC', code: 'PUBG60', costPrice: 13000, basic: 15000, gold: 14500, platinum: 14000 },
        { name: 'PUBG 325 UC', code: 'PUBG325', costPrice: 65000, basic: 75000, gold: 73000, platinum: 71000 },
    ]},

    // TV & Streaming
    { category: 'TV & Streaming', brand: 'Netflix', items: [
        { name: 'Netflix 1 Bulan Mobile', code: 'NETFLIX-M', costPrice: 49000, basic: 54000, gold: 52000, platinum: 51000 },
    ]},
    { category: 'TV & Streaming', brand: 'Spotify', items: [
        { name: 'Spotify Premium 1 Bulan', code: 'SPOTIFY1M', costPrice: 45000, basic: 50000, gold: 48000, platinum: 47000 },
    ]},
];

async function seed() {
    try {
        await mongoose.connect(MONGO_URI);
        console.log('Connected to MongoDB');

        // Clear existing data
        await Category.deleteMany({});
        await Product.deleteMany({});
        console.log('Cleared existing categories and products');

        // Create categories
        const createdCategories = await Category.insertMany(categories);
        console.log(`Created ${createdCategories.length} categories`);

        // Create category map
        const categoryMap = new Map<string, string>();
        createdCategories.forEach((cat) => {
            categoryMap.set(cat.name, cat._id.toString());
        });

        // Create products
        const products: any[] = [];
        for (const template of productTemplates) {
            const categoryId = categoryMap.get(template.category);
            for (const item of template.items) {
                products.push({
                    name: item.name,
                    code: item.code,
                    category: template.category,
                    categoryId,
                    brand: template.brand,
                    costPrice: item.costPrice,
                    price: {
                        basic: item.basic,
                        gold: item.gold,
                        platinum: item.platinum,
                    },
                    vendor: {
                        name: 'Digiflazz',
                        sku: item.code.toLowerCase(),
                    },
                    status: true,
                });
            }
        }

        // insertMany bypasses Mongoose save hooks; assign atomic productIds explicitly.
        const { allocateProductId } = await import('../services/productIdCounter');
        for (const product of products) {
            product.productId = await allocateProductId();
        }
        const createdProducts = await Product.insertMany(products);
        console.log(`Created ${createdProducts.length} products`);

        console.log('\nSeed completed successfully!');
        console.log(`- ${createdCategories.length} categories`);
        console.log(`- ${createdProducts.length} products`);

        process.exit(0);
    } catch (error) {
        console.error('Seed failed:', error);
        process.exit(1);
    }
}

seed();
