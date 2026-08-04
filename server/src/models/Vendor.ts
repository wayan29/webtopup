import mongoose, { Document, Schema } from 'mongoose';

export interface IVendor extends Document {
    name: string;
    apiBaseUrl: string;
    config: Record<string, any>;
    lowBalanceThreshold: number;
    status: boolean;
    createdAt: Date;
    updatedAt: Date;
}

const VendorSchema: Schema = new Schema({
    name: { type: String, required: true, unique: true },
    apiBaseUrl: { type: String, required: true },
    config: { type: Schema.Types.Mixed, default: {} }, // Encrypted keys should go here
    lowBalanceThreshold: { type: Number, default: 0, min: 0 },
    status: { type: Boolean, default: true }
}, {
    timestamps: true
});

export default mongoose.model<IVendor>('Vendor', VendorSchema);
