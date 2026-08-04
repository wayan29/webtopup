import mongoose, { Document, Schema } from 'mongoose';

export interface ISettings extends Document {
    key: string;
    value: any;
    description?: string;
    createdAt: Date;
    updatedAt: Date;
}

const SettingsSchema: Schema = new Schema({
    key: { type: String, required: true, unique: true },
    value: { type: Schema.Types.Mixed, required: true },
    description: { type: String }
}, {
    timestamps: true
});

export default mongoose.model<ISettings>('Settings', SettingsSchema);
