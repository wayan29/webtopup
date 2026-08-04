import mongoose from 'mongoose';
import dotenv from 'dotenv';
import bcrypt from 'bcrypt';
import { User } from '../models';

dotenv.config();

async function listAllUsers() {
    try {
        // Connect to MongoDB
        await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/pobb');
        console.log('Connected to MongoDB\n');

        // Get all users
        const users = await User.find().select('name email role level balance createdAt');
        
        if (users.length === 0) {
            console.log('No users found in database.');
            console.log('Creating default admin user...');
            
            const defaultAdmin = await User.create({
                name: 'Super Admin',
                email: 'admin@pobb.com', 
                password: 'admin123456',
                role: 'admin',
                level: 'platinum',
                balance: 1000000
            });
            
            console.log('✅ Default admin created!');
            console.log(`Email: ${defaultAdmin.email}`);
            console.log(`Password: admin123456`);
        } else {
            console.log(`Found ${users.length} users:\n`);
            users.forEach((user, index) => {
                console.log(`${index + 1}. ${user.name}`);
                console.log(`   Email: ${user.email}`);
                console.log(`   Role: ${user.role}`);
                console.log(`   Level: ${user.level}`);
                console.log(`   Balance: Rp ${user.balance.toLocaleString('id-ID')}`);
                console.log(`   Created: ${user.createdAt.toLocaleDateString()}`);
                console.log('');
            });
        }

    } catch (error) {
        console.error('Error:', error);
    } finally {
        await mongoose.disconnect();
        console.log('Disconnected from MongoDB');
    }
}

listAllUsers();
