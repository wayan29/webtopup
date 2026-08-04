import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { User, Product, Transaction, Vendor } from '../models';

dotenv.config();

const seed = async () => {
    try {
        const mongoURI = process.env.MONGO_URI || 'mongodb://localhost:27017/pobb';
        await mongoose.connect(mongoURI);
        console.log('MongoDB Connected for Seeding...');

        // Clear existing data
        await User.deleteMany({});
        await Product.deleteMany({});
        await Transaction.deleteMany({});
        await Vendor.deleteMany({});

        // Create Vendor
        const vendor = await Vendor.create({
            name: 'Digiflazz',
            apiBaseUrl: 'https://api.digiflazz.com/v1',
            config: { username: 'demo', key: 'demo123' }
        });
        console.log('Vendor created:', vendor.name);

        // Create Product
        const product = await Product.create({
            code: 'ML-5',
            name: 'Mobile Legends 5 Diamonds',
            category: 'Games',
            brand: 'Mobile Legends',
            price: { basic: 1500, gold: 1450, platinum: 1400 },
            vendor: { name: vendor.name, sku: 'ML-5-VENDOR' }
        });
        console.log('Product created:', product.name);

        // Create User
        const user = await User.create({
            email: 'admin@pobb.com',
            password: 'password123', // Will be hashed by pre-save hook
            name: 'Admin User',
            role: 'admin',
            level: 'platinum',
            balance: 1000000
        });
        console.log('User created:', user.name);

        // Create Transaction
        const trx = await Transaction.create({
            user: user._id,
            product: product._id,
            target: '12345678 (Zone 1)',
            amount: product.price.platinum,
            status: 'success',
            vendorTrxId: 'TRX-VENDOR-001'
        });
        console.log('Transaction created:', trx._id);

        console.log('Seeding Completed Successfully!');
        process.exit(0);
    } catch (err) {
        console.error('Seeding Error:', err);
        process.exit(1);
    }
};

seed();
