import mongoose, { Document, Schema } from 'mongoose';

export interface IGuestTransaction extends Document {
    invoiceNumber: string;
    user?: mongoose.Types.ObjectId;
    product: mongoose.Types.ObjectId;
    target: string;
    serverId?: string;
    whatsapp: string;
    email?: string;
    amount: number;
    adminFee: number;
    uniqueCode: number;
    totalAmount: number;
    paymentMethod: mongoose.Types.ObjectId;
    paymentStatus: 'waiting_payment' | 'paid' | 'expired' | 'cancelled';
    transactionStatus: 'pending' | 'processing' | 'success' | 'failed';
    vendorTrxId?: string;
    sn?: string;
    paidAt?: Date;
    statusUpdatedBy?: mongoose.Types.ObjectId;
    statusUpdatedAt?: Date;
    statusUpdateNote?: string;
    expiredAt: Date;
    createdAt: Date;
    updatedAt: Date;
}

const GuestTransactionSchema: Schema = new Schema({
    invoiceNumber: { type: String, required: true, unique: true },
    user: { type: Schema.Types.ObjectId, ref: 'User' },
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    target: { type: String, required: true },
    serverId: { type: String, trim: true },
    whatsapp: { type: String, required: true },
    email: { type: String },
    amount: { type: Number, required: true },
    adminFee: { type: Number, default: 0 },
    uniqueCode: { type: Number, required: true },
    totalAmount: { type: Number, required: true },
    paymentMethod: { type: Schema.Types.ObjectId, ref: 'PaymentMethod', required: true },
    paymentStatus: {
        type: String,
        enum: ['waiting_payment', 'paid', 'expired', 'cancelled'],
        default: 'waiting_payment'
    },
    transactionStatus: {
        type: String,
        enum: ['pending', 'processing', 'success', 'failed'],
        default: 'pending'
    },
    vendorTrxId: { type: String },
    sn: { type: String },
    paidAt: { type: Date },
    statusUpdatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    statusUpdatedAt: { type: Date },
    statusUpdateNote: { type: String, trim: true },
    expiredAt: { type: Date, required: true }
}, {
    timestamps: true
});

export default mongoose.model<IGuestTransaction>('GuestTransaction', GuestTransactionSchema);
