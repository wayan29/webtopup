import mongoose, { Document, Schema } from 'mongoose';

export interface IPointTransaction extends Document {
    user: mongoose.Types.ObjectId;
    type: 'earn' | 'redeem' | 'admin_adjustment';
    points: number;
    description: string;
    relatedTransaction?: mongoose.Types.ObjectId;
    relatedReward?: mongoose.Types.ObjectId;
    createdAt: Date;
    updatedAt: Date;
}

const PointTransactionSchema: Schema = new Schema({
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: {
        type: String,
        enum: ['earn', 'redeem', 'admin_adjustment'],
        required: true
    },
    points: { type: Number, required: true }, // Positive for earn, negative for redeem
    description: { type: String, required: true },
    relatedTransaction: { type: Schema.Types.ObjectId, ref: 'Transaction' },
    relatedReward: { type: Schema.Types.ObjectId, ref: 'Reward' }
}, {
    timestamps: true
});

// Index for better query performance
PointTransactionSchema.index({ user: 1, createdAt: -1 });
PointTransactionSchema.index({ type: 1 });
PointTransactionSchema.index({ type: 1, relatedReward: 1 });
PointTransactionSchema.index({ type: 1, createdAt: -1 });

export default mongoose.model<IPointTransaction>('PointTransaction', PointTransactionSchema);
