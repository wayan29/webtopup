import mongoose, { Document, Schema } from 'mongoose';

export interface ITransaction extends Document {
    user: mongoose.Types.ObjectId;
    product: mongoose.Types.ObjectId;
    target: string;
    serverId?: string;
    amount: number;
    status: 'pending' | 'processing' | 'success' | 'failed';
    referenceId?: string;
    vendorTrxId?: string;
    customerRefId?: string;
    sn?: string;
    message?: string;
    refunded?: boolean;
    refundedBy?: mongoose.Types.ObjectId;
    refundedAt?: Date;
    refundReason?: string;
    source?: 'web' | 'api';
    statusUpdatedBy?: mongoose.Types.ObjectId;
    statusUpdatedAt?: Date;
    statusUpdateNote?: string;
    createdAt: Date;
    updatedAt: Date;
}

const TransactionSchema: Schema = new Schema({
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    target: { type: String, required: true },
    serverId: { type: String, trim: true },
    amount: { type: Number, required: true },
    status: {
        type: String,
        enum: ['pending', 'processing', 'success', 'failed'],
        default: 'pending'
    },
    referenceId: { type: String },
    vendorTrxId: { type: String },
    customerRefId: { type: String },
    sn: { type: String },
    message: { type: String },
    refunded: { type: Boolean, default: false },
    refundedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    refundedAt: { type: Date },
    refundReason: { type: String, trim: true, maxlength: 300 },
    source: { type: String, enum: ['web', 'api'], default: 'web' },
    statusUpdatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    statusUpdatedAt: { type: Date },
    statusUpdateNote: { type: String, trim: true }
}, {
    timestamps: true
});

TransactionSchema.index({ customerRefId: 1, user: 1 });

export default mongoose.model<ITransaction>('Transaction', TransactionSchema);
