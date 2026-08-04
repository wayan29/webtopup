import mongoose, { Document, Schema } from 'mongoose';

export interface ICategory extends Document {
    categoryId: number;
    name: string;
    slug: string;
    icon: string;
    sortOrder: number;
    status: boolean;
    createdAt: Date;
    updatedAt: Date;
}

const CategorySchema: Schema = new Schema({
    categoryId: { type: Number, unique: true },
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    icon: { type: String, default: '📦' },
    sortOrder: { type: Number, default: 0 },
    status: { type: Boolean, default: true }
}, {
    timestamps: true
});

// Auto-increment categoryId
CategorySchema.pre('save', async function(next) {
    if (this.isNew && !this.categoryId) {
        const last = await mongoose.model('Category').findOne().sort({ categoryId: -1 }).select('categoryId');
        this.categoryId = (last?.categoryId || 0) + 1;
    }
    next();
});

// categoryId index already created by unique: true
CategorySchema.index({ sortOrder: 1 });
CategorySchema.index({ status: 1 });

export default mongoose.model<ICategory>('Category', CategorySchema);
