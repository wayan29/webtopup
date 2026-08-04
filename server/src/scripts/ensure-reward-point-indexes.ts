import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { PointTransaction, Voucher } from '../models';

dotenv.config();

const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/webtopup';

async function ensureRewardPointIndexes() {
    await mongoose.connect(mongoUri);

    await PointTransaction.collection.createIndex(
        { type: 1, relatedReward: 1 },
        { name: 'type_1_relatedReward_1', background: true }
    );

    await PointTransaction.collection.createIndex(
        { type: 1, createdAt: -1 },
        { name: 'type_1_createdAt_-1', background: true }
    );

    await PointTransaction.collection.createIndex(
        { user: 1, createdAt: -1 },
        { name: 'user_1_createdAt_-1', background: true }
    );

    await Voucher.collection.createIndex(
        { code: 1 },
        { name: 'code_1', unique: true, background: true }
    );

    await Voucher.collection.createIndex(
        { isArchived: 1, isRedeemed: 1, createdAt: -1 },
        { name: 'isArchived_1_isRedeemed_1_createdAt_-1', background: true }
    );

    console.log('Reward/points/voucher indexes ensured successfully');
}

ensureRewardPointIndexes()
    .catch(error => {
        console.error('Failed to ensure reward/points/voucher indexes', error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await mongoose.disconnect();
    });
