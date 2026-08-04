import mongoose, { Document, Schema } from 'mongoose';

export interface IPopupInfo {
    title: string;
    content: string;
    image: string;
    buttonText: string;
    buttonLink: string;
    enabled: boolean;
}

export interface IProductType extends Document {
    typeId: number;
    name: string;
    slug: string;
    categoryId: mongoose.Types.ObjectId;
    operatorId: mongoose.Types.ObjectId;
    icon: string;
    cover: string;
    openTime: string;
    closeTime: string;
    open24Hours: boolean;
    estimatedDelivery: string;
    processType: 'auto' | 'manual';
    description: string;
    popupInfo: IPopupInfo;
    sortOrder: number;
    status: boolean;
    createdAt: Date;
    updatedAt: Date;
}

const PopupInfoSchema = new Schema({
    title: { type: String, default: '' },
    content: { type: String, default: '' },
    image: { type: String, default: '' },
    buttonText: { type: String, default: '' },
    buttonLink: { type: String, default: '' },
    enabled: { type: Boolean, default: false }
}, { _id: false });

const ProductTypeSchema: Schema = new Schema({
    typeId: { type: Number, unique: true },
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, lowercase: true, trim: true },
    categoryId: { type: Schema.Types.ObjectId, ref: 'Category', required: true },
    operatorId: { type: Schema.Types.ObjectId, ref: 'Operator', required: true },
    icon: { type: String, default: '' },
    cover: { type: String, default: '' },
    openTime: { type: String, default: '00:00' },
    closeTime: { type: String, default: '23:59' },
    open24Hours: { type: Boolean, default: true },
    estimatedDelivery: { type: String, default: '' },
    processType: { type: String, enum: ['auto', 'manual'], default: 'auto' },
    description: { type: String, default: '' },
    popupInfo: { type: PopupInfoSchema, default: () => ({}) },
    sortOrder: { type: Number, default: 0 },
    status: { type: Boolean, default: true }
}, {
    timestamps: true
});

// Auto-increment typeId
ProductTypeSchema.pre('save', async function(next) {
    if (this.isNew && !this.typeId) {
        const last = await mongoose.model('ProductType').findOne().sort({ typeId: -1 }).select('typeId');
        this.typeId = (last?.typeId || 0) + 1;
    }
    next();
});

// typeId index already created by unique: true
ProductTypeSchema.index({ categoryId: 1, operatorId: 1, sortOrder: 1 });
ProductTypeSchema.index({ status: 1 });

export default mongoose.model<IProductType>('ProductType', ProductTypeSchema);
