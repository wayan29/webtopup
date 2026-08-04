import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IPaymentMethod extends Document {
    name: string;
    category: Types.ObjectId;
    accountNumber: string;
    accountName: string;
    icon?: string;
    minAmount: number;
    maxAmount: number;
    adminFee: number;
    adminPercent: number;
    operationalStart: string;
    operationalEnd: string;
    useUniqueCode: boolean;
    status: 'active' | 'inactive';
    createdAt: Date;
    updatedAt: Date;
}

const PaymentMethodSchema: Schema = new Schema({
    name: { type: String, required: true },
    category: {
        type: Schema.Types.ObjectId,
        ref: 'PaymentCategory'
    },
    accountNumber: { type: String, required: true },
    accountName: { type: String, required: true },
    icon: { type: String, default: '' },
    minAmount: { type: Number, default: 10000 },
    maxAmount: { type: Number, default: 5000000 },
    adminFee: { type: Number, default: 0 },
    adminPercent: { type: Number, default: 0 },
    operationalStart: { type: String, default: '00:00' },
    operationalEnd: { type: String, default: '23:59' },
    useUniqueCode: { type: Boolean, default: true },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
}, { timestamps: true });

export default mongoose.model<IPaymentMethod>('PaymentMethod', PaymentMethodSchema);
