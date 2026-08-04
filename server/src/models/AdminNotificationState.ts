import mongoose, { Document, Schema } from 'mongoose';

export interface IAdminNotificationState extends Document {
    user: mongoose.Types.ObjectId;
    notificationId: string;
    fingerprint: string;
    readAt?: Date;
    dismissedAt?: Date;
    createdAt: Date;
    updatedAt: Date;
}

const AdminNotificationStateSchema = new Schema<IAdminNotificationState>({
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    notificationId: { type: String, required: true },
    fingerprint: { type: String, required: true },
    readAt: { type: Date },
    dismissedAt: { type: Date }
}, {
    timestamps: true
});

AdminNotificationStateSchema.index({ user: 1, notificationId: 1, fingerprint: 1 }, { unique: true });
AdminNotificationStateSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export default mongoose.model<IAdminNotificationState>('AdminNotificationState', AdminNotificationStateSchema);
