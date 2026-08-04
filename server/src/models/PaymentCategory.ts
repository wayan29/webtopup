import mongoose, { Document, Schema } from 'mongoose';

export interface IPaymentCategory extends Document {
    name: string;
    slug: string;
    icon?: string;
    order: number;
    status: 'active' | 'inactive';
    createdAt: Date;
    updatedAt: Date;
}

const PaymentCategorySchema: Schema = new Schema({
    name: { type: String, required: true, unique: true },
    slug: { type: String, required: true, unique: true },
    icon: { type: String, default: '' },
    order: { type: Number, default: 0 },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
}, { timestamps: true });

PaymentCategorySchema.pre('save', function(next) {
    if (this.isModified('name') && !this.slug) {
        this.slug = (this.name as string).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    }
    next();
});

export default mongoose.model<IPaymentCategory>('PaymentCategory', PaymentCategorySchema);
