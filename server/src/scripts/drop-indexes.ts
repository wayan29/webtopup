import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { Product } from '../models';

dotenv.config();

const dropIndexes = async () => {
    try {
        const mongoURI = process.env.MONGO_URI || 'mongodb://localhost:27017/pobb';
        await mongoose.connect(mongoURI);
        console.log('MongoDB Connected...');

        console.log('Dropping indexes for Product collection...');
        await Product.collection.dropIndexes();
        console.log('Indexes dropped.');

        process.exit(0);
    } catch (err) {
        console.error('Error:', err);
        process.exit(1);
    }
};

dropIndexes();
