import mongoose, { Document, Schema } from 'mongoose';
import bcrypt from 'bcrypt';

export interface ITeamPermissions {
    // Dashboard & Reports
    viewDashboard: boolean;
    viewReports: boolean;
    
    // Transactions
    viewTransactions: boolean;
    processManualTransaction: boolean;
    
    // Deposits
    viewDeposits: boolean;
    approveDeposits: boolean;
    
    // Products
    viewProducts: boolean;
    manageProducts: boolean;

    // Vouchers
    manageVouchers: boolean;
    
    // Payment
    viewPayment: boolean;
    managePayment: boolean;
    
    // Users
    viewUsers: boolean;
    manageUsers: boolean;
    
    // Team
    viewTeam: boolean;
    manageTeam: boolean;
    
    // Settings
    viewSettings: boolean;
    manageSettings: boolean;
    
    // Vendors
    viewVendors: boolean;
    manageVendors: boolean;
}

export interface IMemberPreferences {
    emailNotifications: boolean;
    smsNotifications: boolean;
    showBalance: boolean;
    uiTheme: 'ember-premium' | 'ember-premium-light' | 'forest-trusted' | 'forest-trusted-light' | 'royal-plum-luxury' | 'royal-plum-luxury-light' | 'graphite-operational' | 'graphite-operational-light' | 'horizon-clean' | 'midnight-elegant' | 'neobrutal-bold';
}

export interface IUser extends Document {
    email: string;
    password?: string;
    name: string;
    phone?: string;
    address?: string;
    avatarUrl?: string;
    role: 'owner' | 'admin' | 'cs' | 'member';
    /**
     * Authoritative stamps for the deterministic security-change binding. The Rust side reads
     * these and falls back to `updatedAt`, but `updatedAt` is rewritten by the very update that
     * prepares the binding, so the fallback compares a value against its own mutation and fails
     * with AuthoritativeMismatch. They must therefore exist from account creation onward.
     */
    roleUpdatedAt?: Date;
    policyUpdatedAt?: Date;
    level: 'basic' | 'gold' | 'platinum';
    balance: number;
    points: number;
    apiKey?: string;
    apiSecret?: string;
    memberCode?: string;
    twoFactorEnabled: boolean;
    twoFactorSecret?: string;
    twoFactorPendingSecret?: string;
    twoFactorPendingAt?: Date;
  twoFactorEnrollmentRequiredAt?: Date;
  twoFactorEnrollmentCompletedAt?: Date;
    sessionVersion: number;
    globalRevocationPending?: { operationId: mongoose.Types.ObjectId; sessionVersion: number; startedAt: Date };
    completedGlobalRevocation?: { operationId: mongoose.Types.ObjectId; sessionVersion: number; completedAt: Date };
    /**
     * Complete private security-change recovery record (select:false).
     * Sensitive digests/ciphertext remain private; gateway admission only projects binding fields.
     * Legacy securityChangePending/completedSecurityChange are retained only as fail-closed stubs.
     */
    securityChange?: {
        operationId: mongoose.Types.ObjectId;
        initiatingSid: mongoose.Types.ObjectId;
        targetUserId: mongoose.Types.ObjectId;
        userId?: mongoose.Types.ObjectId;
        kind: string;
        method: string;
        path: string;
        previousEpoch: number;
        resultEpoch: number;
        authenticatedRole?: string;
        sourceRecoveryGeneration?: number;
        resultSid?: mongoose.Types.ObjectId;
        resultSlot?: number;
        startedAt?: Date;
        sourceAbsoluteExpiresAt?: Date;
        recoveryExpiresAt: Date;
        continuationDigest?: Buffer;
        phase?: string;
        cleanupPhase?: string;
        claims?: { jti?: string; iat?: number; exp?: number };
        successorRefreshDigest?: Buffer;
        successorRecoveryDigest?: Buffer;
        derivationKeyId?: string;
        derivationVersion?: string;
        encryptedPredecessor?: {
            ciphertext?: Buffer;
            nonce?: Buffer;
            keyId?: string;
            version?: string;
        };
        authoritativeRoleUpdatedAt?: Date;
        authoritativePolicyUpdatedAt?: Date;
        issueResultSession?: boolean;
        mutationApplied?: boolean;
        result?: { enabled?: boolean; message?: string };
        terminalAt?: Date;
        issuedAt?: Date;
        finalizedAt?: Date;
        revocationCompletedAt?: Date;
    };
    /** @deprecated Competing legacy protocol; presence fails closed at admission. */
    securityChangePending?: { operationId: mongoose.Types.ObjectId; sessionVersion: number; kind: string; startedAt: Date };
    /** @deprecated Competing legacy protocol; presence fails closed at admission. */
    completedSecurityChange?: { operationId: mongoose.Types.ObjectId; sessionVersion: number; kind: string; completedAt: Date };
    permissions?: ITeamPermissions;
    preferences?: IMemberPreferences;
    createdBy?: mongoose.Types.ObjectId;
    active: boolean;
    createdAt: Date;
    updatedAt: Date;
    comparePassword(candidatePassword: string): Promise<boolean>;
}

const PermissionsSchema = new Schema({
    viewDashboard: { type: Boolean, default: true },
    viewReports: { type: Boolean, default: false },
    viewTransactions: { type: Boolean, default: false },
    processManualTransaction: { type: Boolean, default: false },
    viewDeposits: { type: Boolean, default: false },
    approveDeposits: { type: Boolean, default: false },
    viewProducts: { type: Boolean, default: false },
    manageProducts: { type: Boolean, default: false },
    manageVouchers: { type: Boolean, default: false },
    viewPayment: { type: Boolean, default: false },
    managePayment: { type: Boolean, default: false },
    viewUsers: { type: Boolean, default: false },
    manageUsers: { type: Boolean, default: false },
    viewTeam: { type: Boolean, default: false },
    manageTeam: { type: Boolean, default: false },
    viewSettings: { type: Boolean, default: false },
    manageSettings: { type: Boolean, default: false },
    viewVendors: { type: Boolean, default: false },
    manageVendors: { type: Boolean, default: false },
}, { _id: false });

const MemberPreferencesSchema = new Schema({
    emailNotifications: { type: Boolean, default: true },
    smsNotifications: { type: Boolean, default: false },
    showBalance: { type: Boolean, default: true },
    uiTheme: {
        type: String,
        enum: ['ember-premium', 'ember-premium-light', 'forest-trusted', 'forest-trusted-light', 'royal-plum-luxury', 'royal-plum-luxury-light', 'graphite-operational', 'graphite-operational-light', 'horizon-clean', 'midnight-elegant', 'neobrutal-bold'],
        default: 'ember-premium'
    }
}, { _id: false });

const UserSchema: Schema = new Schema({
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, minlength: 12 },
    name: { type: String, required: true, trim: true },
    phone: { type: String, trim: true },
    address: { type: String, trim: true },
    avatarUrl: { type: String, default: '' },
    role: { type: String, enum: ['owner', 'admin', 'cs', 'member'], default: 'member' },
    roleUpdatedAt: { type: Date },
    policyUpdatedAt: { type: Date },
    level: { type: String, enum: ['basic', 'gold', 'platinum'], default: 'basic' },
    balance: { type: Number, default: 0, min: 0 },
    points: { type: Number, default: 0, min: 0 },
    apiKey: { type: String, unique: true, sparse: true },
    apiSecret: { type: String },
    memberCode: { type: String, unique: true, sparse: true },
    twoFactorEnabled: { type: Boolean, default: false },
    twoFactorSecret: { type: String, select: false },
    twoFactorPendingSecret: { type: String, select: false },
    twoFactorPendingAt: { type: Date, select: false },
  twoFactorEnrollmentRequiredAt: { type: Date },
  twoFactorEnrollmentCompletedAt: { type: Date },
    sessionVersion: { type: Number, default: 0, min: 0 },
    globalRevocationPending: {
        type: { operationId: Schema.Types.ObjectId, sessionVersion: Number, startedAt: Date },
        required: false,
        select: false,
    },
    completedGlobalRevocation: {
        type: { operationId: Schema.Types.ObjectId, sessionVersion: Number, completedAt: Date },
        required: false,
        select: false,
    },
    securityChange: {
        type: {
            operationId: Schema.Types.ObjectId,
            initiatingSid: Schema.Types.ObjectId,
            targetUserId: Schema.Types.ObjectId,
            userId: Schema.Types.ObjectId,
            kind: String,
            method: String,
            path: String,
            previousEpoch: Number,
            resultEpoch: Number,
            authenticatedRole: String,
            sourceRecoveryGeneration: Number,
            resultSid: Schema.Types.ObjectId,
            resultSlot: Number,
            startedAt: Date,
            sourceAbsoluteExpiresAt: Date,
            recoveryExpiresAt: Date,
            continuationDigest: { type: Buffer, select: false },
            phase: String,
            cleanupPhase: String,
            claims: {
                type: { jti: String, iat: Number, exp: Number },
                required: false,
                select: false,
            },
            successorRefreshDigest: { type: Buffer, select: false },
            successorRecoveryDigest: { type: Buffer, select: false },
            derivationKeyId: { type: String, select: false },
            derivationVersion: { type: String, select: false },
            encryptedPredecessor: {
                type: {
                    ciphertext: Buffer,
                    nonce: Buffer,
                    keyId: String,
                    version: String,
                },
                required: false,
                select: false,
            },
            authoritativeRoleUpdatedAt: Date,
            authoritativePolicyUpdatedAt: Date,
            issueResultSession: Boolean,
            mutationApplied: Boolean,
            result: {
                type: { enabled: Boolean, message: String },
                required: false,
            },
            terminalAt: Date,
            issuedAt: Date,
            finalizedAt: Date,
            revocationCompletedAt: Date,
        },
        required: false,
        select: false,
    },
    // Legacy competing protocol stubs — never selected for admission success paths.
    securityChangePending: {
        type: { operationId: Schema.Types.ObjectId, sessionVersion: Number, kind: String, startedAt: Date },
        required: false,
        select: false,
    },
    completedSecurityChange: {
        type: { operationId: Schema.Types.ObjectId, sessionVersion: Number, kind: String, completedAt: Date },
        required: false,
        select: false,
    },
    permissions: { type: PermissionsSchema, default: () => ({}) },
    preferences: { type: MemberPreferencesSchema, default: () => ({}) },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    active: { type: Boolean, default: true }
}, {
    timestamps: true
});

// Indexes for better query performance
// Note: email index is already created via unique: true
UserSchema.index({ role: 1 });
UserSchema.index({ level: 1 });
UserSchema.index({ createdAt: -1 });
UserSchema.index({ balance: -1 });
UserSchema.index({ apiKey: 1, memberCode: 1 });

UserSchema.methods.comparePassword = async function(candidatePassword: string): Promise<boolean> {
    if (!this.password) return false;
    return bcrypt.compare(candidatePassword, this.password);
};

UserSchema.methods.adjustBalance = async function(amount: number): Promise<IUser> {
    const newBalance = this.balance + amount;
    if (newBalance < 0) {
        throw new Error('Insufficient balance');
    }
    this.balance = newBalance;
    return this.save();
};

UserSchema.pre('save', async function (next) {
    // Seed the security-change stamps on creation, and move roleUpdatedAt whenever the role
    // actually changes. Without these a freshly created staff account cannot complete 2FA
    // enrollment: the binding falls back to updatedAt and mismatches against itself.
    const now = new Date();
    if (this.isNew) {
        if (!this.roleUpdatedAt) this.roleUpdatedAt = now;
        if (!this.policyUpdatedAt) this.policyUpdatedAt = now;
    } else if (this.isModified('role')) {
        this.roleUpdatedAt = now;
    }
    if (!this.isModified('password') || !this.password) return next();
    try {
        const salt = await bcrypt.genSalt(10);
        this.password = await bcrypt.hash(this.password as string, salt);
        next();
    } catch (error: any) {
        next(error);
    }
});

export default mongoose.model<IUser>('User', UserSchema);
