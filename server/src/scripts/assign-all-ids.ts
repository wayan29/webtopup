import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/ppob';

async function assignIds() {
    try {
        await mongoose.connect(MONGO_URI);
        console.log('Connected to MongoDB');

        const db = mongoose.connection.db;
        if (!db) {
            console.error('Database not found');
            return;
        }

        // Assign categoryId
        console.log('\n=== Assigning categoryId ===');
        const categoriesCollection = db.collection('categories');
        const categories = await categoriesCollection
            .find({ $or: [{ categoryId: null }, { categoryId: { $exists: false } }] })
            .sort({ createdAt: 1 })
            .toArray();
        
        if (categories.length > 0) {
            const maxCat = await categoriesCollection.findOne(
                { categoryId: { $exists: true, $ne: null } },
                { sort: { categoryId: -1 } }
            );
            let nextCatId = (maxCat?.categoryId || 0) + 1;
            
            for (const cat of categories) {
                await categoriesCollection.updateOne(
                    { _id: cat._id },
                    { $set: { categoryId: nextCatId } }
                );
                console.log(`Category #${nextCatId}: ${cat.name}`);
                nextCatId++;
            }
            console.log(`Assigned ${categories.length} categories`);
        } else {
            console.log('All categories already have categoryId');
        }

        // Assign operatorId
        console.log('\n=== Assigning operatorId ===');
        const operatorsCollection = db.collection('operators');
        const operators = await operatorsCollection
            .find({ $or: [{ operatorId: null }, { operatorId: { $exists: false } }] })
            .sort({ createdAt: 1 })
            .toArray();
        
        if (operators.length > 0) {
            const maxOp = await operatorsCollection.findOne(
                { operatorId: { $exists: true, $ne: null } },
                { sort: { operatorId: -1 } }
            );
            let nextOpId = (maxOp?.operatorId || 0) + 1;
            
            for (const op of operators) {
                await operatorsCollection.updateOne(
                    { _id: op._id },
                    { $set: { operatorId: nextOpId } }
                );
                console.log(`Operator #${nextOpId}: ${op.name}`);
                nextOpId++;
            }
            console.log(`Assigned ${operators.length} operators`);
        } else {
            console.log('All operators already have operatorId');
        }

        // Assign typeId
        console.log('\n=== Assigning typeId ===');
        const productTypesCollection = db.collection('producttypes');
        const productTypes = await productTypesCollection
            .find({ $or: [{ typeId: null }, { typeId: { $exists: false } }] })
            .sort({ createdAt: 1 })
            .toArray();
        
        if (productTypes.length > 0) {
            const maxType = await productTypesCollection.findOne(
                { typeId: { $exists: true, $ne: null } },
                { sort: { typeId: -1 } }
            );
            let nextTypeId = (maxType?.typeId || 0) + 1;
            
            for (const pt of productTypes) {
                await productTypesCollection.updateOne(
                    { _id: pt._id },
                    { $set: { typeId: nextTypeId } }
                );
                console.log(`ProductType #${nextTypeId}: ${pt.name}`);
                nextTypeId++;
            }
            console.log(`Assigned ${productTypes.length} product types`);
        } else {
            console.log('All product types already have typeId');
        }

        console.log('\n=== Done! ===');
        await mongoose.disconnect();
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

assignIds();
