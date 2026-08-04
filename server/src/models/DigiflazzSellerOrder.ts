import mongoose, { Document, Schema } from 'mongoose';

export interface IDigiflazzSellerOrder extends Document {
    refId: string;
    trId: string;
    mapping: mongoose.Types.ObjectId;
    product: mongoose.Types.ObjectId;
    pulsaCode: string;
    target: string;
    digiflazzPrice: number;
    status: 'pending' | 'success' | 'failed';
    rc: string;
    message: string;
    vendorName?: string;
    vendorSku?: string;
    vendorTrxId?: string;
    sn?: string;
    requestIp?: string;
    callbackRequired: boolean;
    callbackAttemptCount: number;
    callbackDeliveredAt?: Date;
    callbackLastAttemptAt?: Date;
    callbackNextRetryAt?: Date;
    callbackLastStatusCode?: number;
    callbackLastMessage?: string;
    rawRequest?: Record<string, unknown>;
    createdAt: Date;
    updatedAt: Date;
}

const DigiflazzSellerOrderSchema: Schema = new Schema({
    refId: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        index: true
    },
    trId: {
        type: String,
        required: true,
        trim: true
    },
    mapping: {
        type: Schema.Types.ObjectId,
        ref: 'DigiflazzSellerProductMap',
        required: true
    },
    product: {
        type: Schema.Types.ObjectId,
        ref: 'Product',
        required: true
    },
    pulsaCode: {
        type: String,
        required: true,
        trim: true,
        lowercase: true
    },
    target: {
        type: String,
        required: true,
        trim: true
    },
    digiflazzPrice: {
        type: Number,
        required: true,
        min: 0
    },
    status: {
        type: String,
        enum: ['pending', 'success', 'failed'],
        default: 'pending'
    },
    rc: {
        type: String,
        required: true,
        trim: true,
        maxlength: 32
    },
    message: {
        type: String,
        required: true,
        trim: true,
        maxlength: 300
    },
    vendorName: {
        type: String,
        trim: true
    },
    vendorSku: {
        type: String,
        trim: true
    },
    vendorTrxId: {
        type: String,
        trim: true,
        index: true
    },
    sn: {
        type: String,
        trim: true
    },
    requestIp: {
        type: String,
        trim: true,
        maxlength: 120
    },
    callbackRequired: {
        type: Boolean,
        default: false
    },
    callbackAttemptCount: {
        type: Number,
        default: 0,
        min: 0
    },
    callbackDeliveredAt: {
        type: Date
    },
    callbackLastAttemptAt: {
        type: Date
    },
    callbackNextRetryAt: {
        type: Date
    },
    callbackLastStatusCode: {
        type: Number
    },
    callbackLastMessage: {
        type: String,
        trim: true,
        maxlength: 500
    },
    rawRequest: {
        type: Schema.Types.Mixed
    }
}, {
    timestamps: true
});

DigiflazzSellerOrderSchema.index({ status: 1, updatedAt: -1 });
DigiflazzSellerOrderSchema.index({ callbackRequired: 1, updatedAt: -1 });
DigiflazzSellerOrderSchema.index({ callbackRequired: 1, callbackNextRetryAt: 1 });
DigiflazzSellerOrderSchema.index({ vendorTrxId: 1, updatedAt: -1 });

export default mongoose.model<IDigiflazzSellerOrder>('DigiflazzSellerOrder', DigiflazzSellerOrderSchema);
