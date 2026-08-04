import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { User } from '../models';

dotenv.config();

async function upgradeToOwner() {
    try {
        await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/ppob');
        console.log('Connected to MongoDB');

        // Find admin user and upgrade to owner
        const result = await User.updateMany(
            { role: 'admin' },
            { 
                $set: { 
                    role: 'owner',
                    permissions: {
                        viewDashboard: true,
                        viewReports: true,
                        viewTransactions: true,
                        processManualTransaction: true,
                        viewDeposits: true,
                        approveDeposits: true,
                        viewProducts: true,
                        manageProducts: true,
                        viewPayment: true,
                        managePayment: true,
                        viewUsers: true,
                        manageUsers: true,
                        viewTeam: true,
                        manageTeam: true,
                        viewSettings: true,
                        manageSettings: true,
                        viewVendors: true,
                        manageVendors: true,
                    }
                }
            }
        );

        console.log(`Upgraded ${result.modifiedCount} admin(s) to owner`);

        // Also upgrade old 'team' role to 'cs'
        const teamResult = await User.updateMany(
            { role: 'team' },
            { $set: { role: 'cs' } }
        );

        console.log(`Upgraded ${teamResult.modifiedCount} team member(s) to cs`);

        // List all owners
        const owners = await User.find({ role: 'owner' }).select('email name');
        console.log('Current owners:', owners);

        process.exit(0);
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

upgradeToOwner();
