import mongoose, { Document, Schema } from 'mongoose';
import { allocateProductId } from '../services/productIdCounter';

export interface IProduct extends Document {
    productId: number;
    code: string;
    name: string;
    category: string; // Legacy field for backward compatibility
    categoryId?: mongoose.Types.ObjectId;
    operatorId?: mongoose.Types.ObjectId;
    productTypeId?: mongoose.Types.ObjectId;
    paymentType?: 'prabayar' | 'pascabayar';
    icon?: string;
    rewardPoints?: number;
    brand: string;
    costPrice: number;
    price: {
        basic: number;
        gold: number;
        platinum: number;
    };
    vendor: {
        name: string;
        sku: string;
    };
    sortOrder: number;
    status: boolean;
    createdAt: Date;
    updatedAt: Date;
}

const ProductSchema: Schema = new Schema({
    productId: { type: Number, unique: true },
    code: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    category: { type: String, required: true }, // Legacy field
    categoryId: { type: Schema.Types.ObjectId, ref: 'Category' },
    operatorId: { type: Schema.Types.ObjectId, ref: 'Operator' },
    productTypeId: { type: Schema.Types.ObjectId, ref: 'ProductType' },
    paymentType: { type: String, enum: ['prabayar', 'pascabayar'], default: 'prabayar' },
    icon: { type: String },
    rewardPoints: { type: Number, default: 0 },
    brand: { type: String, required: true },
    costPrice: { type: Number, default: 0 },
    price: {
        basic: { type: Number, required: true },
        gold: { type: Number, required: true },
        platinum: { type: Number, required: true }
    },
    vendor: {
        name: { type: String },
        sku: { type: String }
    },
    sortOrder: { type: Number, default: 0 },
    status: { type: Boolean, default: true }
}, {
    timestamps: true
});

// Auto-increment productId via shared atomic counter (never max+1)
ProductSchema.pre('save', async function(next) {
    if (this.isNew && (this.productId === undefined || this.productId === null)) {
        try {
            this.productId = await allocateProductId();
        } catch (error) {
            next(error instanceof Error ? error : new Error(String(error)));
            return;
        }
    }
    next();
});

// productId index already created by unique: true
ProductSchema.index({ categoryId: 1 });
ProductSchema.index({ status: 1 });

export default mongoose.model<IProduct>('Product', ProductSchema);
