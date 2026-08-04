import mongoose, { Document, Schema } from 'mongoose';

export interface ILoginLog extends Document {
    user: mongoose.Types.ObjectId;
    email: string;
    role: string;
    ip: string;
    userAgent: string;
    status: 'success' | 'failed';
    failReason?: string;
    createdAt: Date;
}

const LoginLogSchema: Schema = new Schema({
    user: { type: Schema.Types.ObjectId, ref: 'User' },
    email: { type: String, required: true },
    role: { type: String },
    ip: { type: String, default: '' },
    userAgent: { type: String, default: '' },
    status: { type: String, enum: ['success', 'failed'], required: true },
    failReason: { type: String },
}, {
    timestamps: true
});

LoginLogSchema.index({ user: 1, createdAt: -1 });
LoginLogSchema.index({ createdAt: -1 });
LoginLogSchema.index({ email: 1 });

export default mongoose.model<ILoginLog>('LoginLog', LoginLogSchema);
