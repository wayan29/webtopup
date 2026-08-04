import mongoose, { Document, Schema } from 'mongoose';

export interface IDigiflazzSellerProductMap extends Document {
    product: mongoose.Types.ObjectId;
    pulsaCode: string;
    price: number;
    sellerMarginFlat?: number;
    isActive: boolean;
    lastSyncStatus: 'never' | 'success' | 'failed';
    lastSyncRc?: string;
    lastSyncMessage?: string;
    lastSyncAt?: Date;
    createdAt: Date;
    updatedAt: Date;
}

const DigiflazzSellerProductMapSchema: Schema = new Schema({
    product: {
        type: Schema.Types.ObjectId,
        ref: 'Product',
        required: true,
        unique: true
    },
    pulsaCode: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        lowercase: true
    },
    price: {
        type: Number,
        required: true,
        min: 0
    },
    sellerMarginFlat: {
        type: Number,
        min: 0
    },
    isActive: {
        type: Boolean,
        default: true
    },
    lastSyncStatus: {
        type: String,
        enum: ['never', 'success', 'failed'],
        default: 'never'
    },
    lastSyncRc: {
        type: String,
        trim: true,
        maxlength: 32
    },
    lastSyncMessage: {
        type: String,
        trim: true,
        maxlength: 300
    },
    lastSyncAt: {
        type: Date
    }
}, {
    timestamps: true
});

DigiflazzSellerProductMapSchema.index({ isActive: 1, updatedAt: -1 });
DigiflazzSellerProductMapSchema.index({ pulsaCode: 1, isActive: 1 });

export default mongoose.model<IDigiflazzSellerProductMap>('DigiflazzSellerProductMap', DigiflazzSellerProductMapSchema);
