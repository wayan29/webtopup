import mongoose from 'mongoose';
import dotenv from 'dotenv';
import bcrypt from 'bcrypt';
import { User } from '../models';

dotenv.config();

const ADMIN_USER = {
    name: 'Super Admin',
    email: 'admin@pobb.com',
    password: 'admin123456',
    role: 'admin' as const,
    level: 'platinum' as const,
    balance: 1000000
};

async function createAdmin() {
    try {
        // Connect to MongoDB
        await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/pobb');
        console.log('Connected to MongoDB');

        // Check if admin already exists
        const existingAdmin = await User.findOne({ email: ADMIN_USER.email });
        if (existingAdmin) {
            console.log('Admin user already exists');
            console.log('Admin details:');
            console.log(`- Name: ${existingAdmin.name}`);
            console.log(`- Email: ${existingAdmin.email}`);
            console.log(`- Role: ${existingAdmin.role}`);
            console.log(`- Level: ${existingAdmin.level}`);
            console.log(`- Balance: Rp ${existingAdmin.balance.toLocaleString('id-ID')}`);
            return;
        }

        // Create admin user
        const adminUser = await User.create(ADMIN_USER);
        
        console.log('✅ Admin user created successfully!');
        console.log('\nAdmin credentials:');
        console.log(`- Name: ${adminUser.name}`);
        console.log(`- Email: ${adminUser.email}`);
        console.log(`- Password: ${ADMIN_USER.password}`);
        console.log(`- Role: ${adminUser.role}`);
        console.log(`- Level: ${adminUser.level}`);
        console.log(`- Balance: Rp ${adminUser.balance.toLocaleString('id-ID')}`);
        console.log('\nYou can now login with these credentials to access the admin dashboard!');

    } catch (error) {
        console.error('Error creating admin user:', error);
    } finally {
        await mongoose.disconnect();
        console.log('Disconnected from MongoDB');
    }
}

// Run the script
createAdmin();
