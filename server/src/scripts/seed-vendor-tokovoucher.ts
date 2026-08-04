import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Vendor from '../models/Vendor';

dotenv.config();

const run = async () => {
    const mongoURI = process.env.MONGO_URI || 'mongodb://localhost:27017/pobb';
    await mongoose.connect(mongoURI);

    const memberCode = process.env.TOKOVOUCHER_MEMBER_CODE || '';
    const secret = process.env.TOKOVOUCHER_SECRET || '';
    const baseUrl = process.env.TOKOVOUCHER_BASE_URL || 'https://api.tokovoucher.net/v1';

    const existing = await Vendor.findOne({ name: /tokovoucher/i });
    if (existing) {
        existing.apiBaseUrl = existing.apiBaseUrl || baseUrl;
        existing.config = {
            ...existing.config,
            memberCode,
            secret
        };
        await existing.save();
        console.log('Updated Tokovoucher vendor config. Fill memberCode/secret in ENV if empty.');
    } else {
        await Vendor.create({
            name: 'Tokovoucher',
            apiBaseUrl: baseUrl,
            config: {
                memberCode,
                secret
            },
            status: true
        });
        console.log('Created Tokovoucher vendor. Fill memberCode/secret in ENV or update via admin.');
    }

    await mongoose.disconnect();
};

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
