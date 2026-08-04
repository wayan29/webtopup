import mongoose, { Document, Schema } from 'mongoose';

export type AdminAuditAction = 'create' | 'update' | 'delete' | 'execute';

export interface IAdminAuditLog extends Document {
    actor?: mongoose.Types.ObjectId;
    actorName: string;
    actorEmail: string;
    actorRole: 'owner' | 'admin' | 'cs' | 'member';
    action: AdminAuditAction;
    resource: string;
    method: string;
    path: string;
    statusCode?: number;
    ip?: string;
    userAgent?: string;
    summary: string;
    metadata?: Record<string, unknown>;
    createdAt: Date;
    updatedAt: Date;
}

const AdminAuditLogSchema: Schema = new Schema({
    actor: { type: Schema.Types.ObjectId, ref: 'User' },
    actorName: { type: String, required: true, trim: true },
    actorEmail: { type: String, required: true, trim: true, lowercase: true },
    actorRole: {
        type: String,
        enum: ['owner', 'admin', 'cs', 'member'],
        required: true
    },
    action: {
        type: String,
        enum: ['create', 'update', 'delete', 'execute'],
        required: true
    },
    resource: { type: String, required: true, trim: true, maxlength: 120 },
    method: { type: String, required: true, trim: true, uppercase: true },
    path: { type: String, required: true, trim: true, maxlength: 500 },
    statusCode: { type: Number },
    ip: { type: String, trim: true },
    userAgent: { type: String, trim: true, maxlength: 500 },
    summary: { type: String, required: true, trim: true, maxlength: 300 },
    metadata: { type: Schema.Types.Mixed }
}, {
    timestamps: true
});

AdminAuditLogSchema.index({ createdAt: -1 });
AdminAuditLogSchema.index({ actor: 1, createdAt: -1 });
AdminAuditLogSchema.index({ resource: 1, createdAt: -1 });
AdminAuditLogSchema.index({ action: 1, createdAt: -1 });

export default mongoose.model<IAdminAuditLog>('AdminAuditLog', AdminAuditLogSchema);
