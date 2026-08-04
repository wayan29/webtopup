import mongoose, { Document, Schema } from 'mongoose';

export type WebhookProvider = 'digiflazz' | 'tokovoucher' | 'digiflazz_seller';

export interface IWebhookEventLog extends Document {
    provider: WebhookProvider;
    event?: string;
    refId: string;
    status: string;
    message: string;
    verified: boolean;
    requestIp?: string;
    raw?: Record<string, unknown>;
    createdAt: Date;
    updatedAt: Date;
}

const WebhookEventLogSchema: Schema = new Schema({
    provider: {
        type: String,
        enum: ['digiflazz', 'tokovoucher', 'digiflazz_seller'],
        required: true
    },
    event: { type: String, trim: true, maxlength: 120 },
    refId: { type: String, required: true, trim: true, maxlength: 120 },
    status: { type: String, required: true, trim: true, maxlength: 60 },
    message: { type: String, required: true, trim: true, maxlength: 500 },
    verified: { type: Boolean, default: false },
    requestIp: { type: String, trim: true, maxlength: 120 },
    raw: { type: Schema.Types.Mixed }
}, {
    timestamps: true
});

WebhookEventLogSchema.index({ provider: 1, createdAt: -1 });
WebhookEventLogSchema.index({ provider: 1, refId: 1, createdAt: -1 });

export default mongoose.model<IWebhookEventLog>('WebhookEventLog', WebhookEventLogSchema);
