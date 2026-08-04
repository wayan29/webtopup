import mongoose, { Document, Schema } from 'mongoose';

export interface IFlashSaleProduct {
    productId: mongoose.Types.ObjectId;
    discountType: 'percentage' | 'fixed';
    discountValue: number;
    stock: number;
    soldCount: number;
}

export interface IFlashSale extends Document {
    name: string;
    description?: string;
    startDate: Date;
    endDate: Date;
    products: IFlashSaleProduct[];
    isActive: boolean;
    banner?: string;
    createdAt: Date;
    updatedAt: Date;
}

const FlashSaleProductSchema = new Schema({
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    discountType: { type: String, enum: ['percentage', 'fixed'], default: 'percentage' },
    discountValue: { type: Number, required: true },
    stock: { type: Number, required: true },
    soldCount: { type: Number, default: 0 }
}, { _id: false });

const FlashSaleSchema: Schema = new Schema({
    name: { type: String, required: true },
    description: { type: String },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    products: [FlashSaleProductSchema],
    isActive: { type: Boolean, default: true },
    banner: { type: String }
}, {
    timestamps: true
});

FlashSaleSchema.index({ startDate: 1, endDate: 1 });
FlashSaleSchema.index({ isActive: 1 });

export default mongoose.model<IFlashSale>('FlashSale', FlashSaleSchema);
