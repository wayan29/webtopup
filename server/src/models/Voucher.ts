import mongoose, { Document, Schema } from 'mongoose';

export interface IVoucher extends Document {
    code: string;
    amount: number;
    isRedeemed: boolean;
    isArchived: boolean;
    redeemedBy?: mongoose.Types.ObjectId;
    redeemedAt?: Date;
    redeemedBalanceBefore?: number;
    redeemedBalanceAfter?: number;
    createdBy?: mongoose.Types.ObjectId;
    archivedBy?: mongoose.Types.ObjectId;
    archivedAt?: Date;
    archiveReason?: string;
    createdAt: Date;
    updatedAt: Date;
}

const voucherSchema = new Schema<IVoucher>({
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    amount: { type: Number, required: true, min: 1 },
    isRedeemed: { type: Boolean, default: false },
    isArchived: { type: Boolean, default: false },
    redeemedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    redeemedAt: { type: Date },
    redeemedBalanceBefore: { type: Number, min: 0 },
    redeemedBalanceAfter: { type: Number, min: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    archivedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    archivedAt: { type: Date },
    archiveReason: { type: String, trim: true }
}, {
    timestamps: true
});

voucherSchema.index({ isArchived: 1, isRedeemed: 1, createdAt: -1 });

export default mongoose.model<IVoucher>('Voucher', voucherSchema);
