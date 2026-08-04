import mongoose from 'mongoose';
import dotenv from 'dotenv';
import bcrypt from 'bcrypt';
import { User } from '../models';

dotenv.config();

async function resetAdminPassword() {
    try {
        await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/pobb');
        console.log('Connected to MongoDB\n');

        // Find admin user
        const adminUser = await User.findOne({ email: 'admin@pobb.com' });
        if (!adminUser) {
            console.log('Admin user not found. Creating new admin...');
            const newAdmin = await User.create({
                name: 'Super Admin',
                email: 'admin@pobb.com',
                password: 'admin123456',
                role: 'admin',
                level: 'platinum',
                balance: 1000000
            });
            console.log('✅ New admin created!');
        } else {
            // Reset password
            adminUser.password = 'admin123456';
            await adminUser.save();
            console.log('✅ Admin password reset!');
        }

        console.log('\nAdmin Credentials:');
        console.log('Email: admin@pobb.com');
        console.log('Password: admin123456');
        console.log('Role: admin');
        console.log('Level: platinum');
        console.log('Balance: Rp 1,000,000');

    } catch (error) {
        console.error('Error:', error);
    } finally {
        await mongoose.disconnect();
        console.log('\nDisconnected from MongoDB');
    }
}

resetAdminPassword();
