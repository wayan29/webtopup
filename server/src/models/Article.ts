import mongoose, { Document, Schema } from 'mongoose';

export interface IArticle extends Document {
    title: string;
    slug: string;
    excerpt: string;
    content: string;
    image?: string;
    category: string;
    status: 'published' | 'draft';
    createdAt: Date;
    updatedAt: Date;
}

const ArticleSchema: Schema = new Schema({
    title: { type: String, required: true },
    slug: { type: String, required: true, unique: true },
    excerpt: { type: String, required: true },
    content: { type: String, required: true },
    image: { type: String },
    category: { type: String, default: 'Umum' },
    status: { type: String, enum: ['published', 'draft'], default: 'draft' }
}, {
    timestamps: true
});

export default mongoose.model<IArticle>('Article', ArticleSchema);
