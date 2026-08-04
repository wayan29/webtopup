import mongoose, { Document, Schema } from 'mongoose';

type TeamAuditAction = 'create' | 'update' | 'activate' | 'deactivate' | 'archive';

export interface ITeamAuditLog extends Document {
    actor?: mongoose.Types.ObjectId;
    actorName: string;
    actorEmail: string;
    targetUser?: mongoose.Types.ObjectId;
    targetName: string;
    targetEmail: string;
    targetRole: 'owner' | 'admin' | 'cs' | 'member';
    action: TeamAuditAction;
    summary: string;
    metadata?: Record<string, unknown>;
    createdAt: Date;
    updatedAt: Date;
}

const TeamAuditLogSchema: Schema = new Schema({
    actor: { type: Schema.Types.ObjectId, ref: 'User' },
    actorName: { type: String, required: true, trim: true },
    actorEmail: { type: String, required: true, trim: true, lowercase: true },
    targetUser: { type: Schema.Types.ObjectId, ref: 'User' },
    targetName: { type: String, required: true, trim: true },
    targetEmail: { type: String, required: true, trim: true, lowercase: true },
    targetRole: {
        type: String,
        enum: ['owner', 'admin', 'cs', 'member'],
        required: true
    },
    action: {
        type: String,
        enum: ['create', 'update', 'activate', 'deactivate', 'archive'],
        required: true
    },
    summary: { type: String, required: true, trim: true, maxlength: 300 },
    metadata: { type: Schema.Types.Mixed }
}, {
    timestamps: true
});

TeamAuditLogSchema.index({ createdAt: -1 });
TeamAuditLogSchema.index({ targetUser: 1, createdAt: -1 });
TeamAuditLogSchema.index({ actor: 1, createdAt: -1 });

export default mongoose.model<ITeamAuditLog>('TeamAuditLog', TeamAuditLogSchema);
