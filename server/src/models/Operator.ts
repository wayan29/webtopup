import mongoose, { Document, Schema } from 'mongoose';

interface ServerOption {
    label: string;
    value: string;
}

export interface IOperator extends Document {
    operatorId: number;
    name: string;
    slug: string;
    categoryId: mongoose.Types.ObjectId;
    icon?: string;
    instructionImage?: string;
    checkUsername: boolean;
    usernameLabel?: string;
    validationType: 'none' | 'freefire' | 'mobilelegends' | 'operator';
    description?: string;
    isCustomProduct: boolean;
    userIdLabel: string;
    userIdType: 'number' | 'text' | 'email';
    hasServerId: boolean;
    serverIdLabel: string;
    serverIdDropdown: boolean;
    serverIdType: 'number' | 'text' | 'email';
    serverOptions: ServerOption[];
    sortOrder: number;
    status: boolean;
    createdAt: Date;
    updatedAt: Date;
}

const ServerOptionSchema = new Schema({
    label: { type: String, required: true },
    value: { type: String, required: true }
}, { _id: false });

const OperatorSchema: Schema = new Schema({
    operatorId: { type: Number, unique: true },
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, lowercase: true, trim: true },
    categoryId: { type: Schema.Types.ObjectId, ref: 'Category', required: true },
    icon: { type: String },
    instructionImage: { type: String },
    checkUsername: { type: Boolean, default: false },
    usernameLabel: { type: String },
    validationType: { type: String, enum: ['none', 'freefire', 'mobilelegends', 'operator'], default: 'none' },
    description: { type: String },
    isCustomProduct: { type: Boolean, default: false },
    userIdLabel: { type: String, default: 'User ID' },
    userIdType: { type: String, enum: ['number', 'text', 'email'], default: 'number' },
    hasServerId: { type: Boolean, default: false },
    serverIdLabel: { type: String, default: 'Server ID' },
    serverIdDropdown: { type: Boolean, default: false },
    serverIdType: { type: String, enum: ['number', 'text', 'email'], default: 'number' },
    serverOptions: { type: [ServerOptionSchema], default: [] },
    sortOrder: { type: Number, default: 0 },
    status: { type: Boolean, default: true }
}, {
    timestamps: true
});

// Auto-increment operatorId
OperatorSchema.pre('save', async function(next) {
    if (this.isNew && !this.operatorId) {
        const last = await mongoose.model('Operator').findOne().sort({ operatorId: -1 }).select('operatorId');
        this.operatorId = (last?.operatorId || 0) + 1;
    }
    next();
});

// operatorId index already created by unique: true
OperatorSchema.index({ categoryId: 1, sortOrder: 1 });
OperatorSchema.index({ slug: 1 });
OperatorSchema.index({ status: 1 });

export default mongoose.model<IOperator>('Operator', OperatorSchema);
