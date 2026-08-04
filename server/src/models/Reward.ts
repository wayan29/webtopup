import mongoose, { Document, Schema } from 'mongoose';

export interface IReward extends Document {
    name: string;
    description: string;
    pointsRequired: number;
    stock: number;
    imageUrl?: string;
    category: string;
    status: boolean;
    createdAt: Date;
    updatedAt: Date;
}

const RewardSchema: Schema = new Schema({
    name: { type: String, required: true },
    description: { type: String, required: true },
    pointsRequired: { type: Number, required: true, min: 1 },
    stock: { type: Number, required: true, default: 0, min: 0 },
    imageUrl: { type: String },
    category: { type: String, required: true },
    status: { type: Boolean, default: true }
}, {
    timestamps: true
});

export default mongoose.model<IReward>('Reward', RewardSchema);
