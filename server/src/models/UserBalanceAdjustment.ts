import mongoose, { Document, Schema } from 'mongoose';

export interface IUserBalanceAdjustment extends Document {
    user: mongoose.Types.ObjectId;
    adjustedBy: mongoose.Types.ObjectId;
    type: 'add' | 'subtract';
    amount: number;
    balanceBefore: number;
    balanceAfter: number;
    reason: string;
    createdAt: Date;
    updatedAt: Date;
}

const UserBalanceAdjustmentSchema: Schema = new Schema({
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    adjustedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: {
        type: String,
        enum: ['add', 'subtract'],
        required: true
    },
    amount: { type: Number, required: true, min: 1 },
    balanceBefore: { type: Number, required: true, min: 0 },
    balanceAfter: { type: Number, required: true, min: 0 },
    reason: { type: String, required: true, trim: true, maxlength: 300 }
}, {
    timestamps: true
});

UserBalanceAdjustmentSchema.index({ user: 1, createdAt: -1 });
UserBalanceAdjustmentSchema.index({ adjustedBy: 1, createdAt: -1 });

export default mongoose.model<IUserBalanceAdjustment>('UserBalanceAdjustment', UserBalanceAdjustmentSchema);
