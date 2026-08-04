import mongoose, { Document, Schema } from 'mongoose';

export interface IDeposit extends Document {
    user: mongoose.Types.ObjectId;
    amount: number;
    uniqueCode: number;
    adminFee: number;
    totalAmount: number;
    paymentMethod?: mongoose.Types.ObjectId;
    status: 'pending' | 'approved' | 'rejected';
    proof?: string;
    assignedTo?: mongoose.Types.ObjectId;
    assignedAt?: Date;
    processedBy?: mongoose.Types.ObjectId;
    processedAt?: Date;
    processingNote?: string;
    createdAt: Date;
    updatedAt: Date;
}

const DepositSchema: Schema = new Schema({
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    amount: { type: Number, required: true },
    uniqueCode: { type: Number, default: 0 },
    adminFee: { type: Number, default: 0 },
    totalAmount: { type: Number, required: true },
    paymentMethod: { type: Schema.Types.ObjectId, ref: 'PaymentMethod' },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    proof: { type: String },
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User' },
    assignedAt: { type: Date },
    processedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    processedAt: { type: Date },
    processingNote: { type: String, trim: true, maxlength: 500 },
}, { timestamps: true });

DepositSchema.index({ status: 1, createdAt: -1 });
DepositSchema.index({ user: 1, createdAt: -1 });
DepositSchema.index({ assignedTo: 1, status: 1 });
DepositSchema.index({ processedBy: 1, processedAt: -1 });

export default mongoose.model<IDeposit>('Deposit', DepositSchema);
