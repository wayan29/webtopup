import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import { FastifyReply } from 'fastify';
import { AuthRequest } from '../middlewares/authMiddleware';
import {
    Deposit,
    LoginLog,
    Transaction,
    User,
    UserBalanceAdjustment,
    Voucher
} from '../models';

type UserLevel = 'basic' | 'gold' | 'platinum';
type BalanceAdjustmentType = 'add' | 'subtract';

interface QueryParams {
    page?: string;
    limit?: string;
    search?: string;
    level?: string;
    status?: string;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
}

interface UpdateUserPayload {
    name?: string;
    email?: string;
    level?: UserLevel;
}

interface UpdateMyProfilePayload {
    name?: string;
    email?: string;
    phone?: string;
    address?: string;
}

interface ChangeMyPasswordPayload {
    currentPassword?: string;
    newPassword?: string;
    confirmPassword?: string;
}

interface UpdateMyPreferencesPayload {
    emailNotifications?: boolean;
    smsNotifications?: boolean;
    showBalance?: boolean;
    uiTheme?: string;
}

interface UserStatusPayload {
    active?: boolean;
}

interface BalanceAdjustmentPayload {
    amount?: number;
    type?: BalanceAdjustmentType;
    reason?: string;
}

interface SanitizedMemberUser {
    _id: unknown;
    name: string;
    email: string;
    level: UserLevel;
    balance: number;
    points: number;
    active: boolean;
    createdAt: Date | string;
    updatedAt: Date | string;
}

interface BalanceAdjustmentResult {
    user: SanitizedMemberUser;
    balanceBefore: number;
    balanceAfter: number;
}

interface BalanceHistoryItem {
    _id: string;
    source: 'deposit' | 'purchase' | 'voucher' | 'adjustment';
    type: 'credit' | 'debit';
    amount: number;
    description: string;
    reference: string;
    createdAt: Date | string;
    balanceBefore?: number;
    balanceAfter?: number;
    meta?: Record<string, unknown>;
}

interface MyProfileResponse {
    id: unknown;
    name: string;
    email: string;
    phone: string;
    address: string;
    role: string;
    level: UserLevel;
    balance: number;
    points: number;
    active: boolean;
    createdAt: Date | string;
    updatedAt: Date | string;
    preferences: {
        emailNotifications: boolean;
        smsNotifications: boolean;
        showBalance: boolean;
        uiTheme: string;
    };
}

class UserControllerError extends Error {
    statusCode: number;

    constructor(statusCode: number, message: string) {
        super(message);
        this.statusCode = statusCode;
    }
}

const MEMBER_LEVELS = new Set<UserLevel>(['basic', 'gold', 'platinum']);
const COMMON_PASSWORDS = new Set([
    'password',
    'password123',
    '12345678',
    '123456789',
    '1234567890',
    'qwerty123',
    'admin123'
]);
const ALLOWED_SORT_FIELDS = new Set(['createdAt', 'updatedAt', 'name', 'email', 'balance']);
const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;

const MEMBER_SELECT_FIELDS = '_id name email level balance points active createdAt updatedAt';

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const parsePositiveInt = (value: string | undefined, fallback: number, max: number) => {
    const parsed = Number.parseInt(value || '', 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }

    return Math.min(parsed, max);
};

const normalizeEmail = (value: string) => value.trim().toLowerCase();
const normalizePhone = (value: string) => value.replace(/\D/g, '');

const isValidEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const isValidPhone = (value: string) => value.length >= 8 && value.length <= 20;

const isTransactionSupportError = (error: unknown) => {
    if (!(error instanceof Error)) {
        return false;
    }

    return /transaction numbers are only allowed on a replica set member or mongos|does not support transactions|transaction support/i.test(error.message);
};

const sanitizeMemberUser = (user: SanitizedMemberUser): SanitizedMemberUser => ({
    _id: user._id,
    name: user.name,
    email: user.email,
    level: user.level,
    balance: user.balance,
    points: user.points,
    active: user.active,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
});

const getMemberPreferences = (user: any) => ({
    emailNotifications: user?.preferences?.emailNotifications !== false,
    smsNotifications: user?.preferences?.smsNotifications === true,
    showBalance: user?.preferences?.showBalance !== false,
    uiTheme: user?.preferences?.uiTheme || 'ember-premium'
});

const UI_THEME_VALUES = new Set([
    'ember-premium',
    'ember-premium-light',
    'forest-trusted',
    'forest-trusted-light',
    'royal-plum-luxury',
    'royal-plum-luxury-light',
    'graphite-operational',
    'graphite-operational-light',
    'horizon-clean',
    'midnight-elegant',
    'neobrutal-bold'
]);

const ensureCurrentAuthenticatedUser = async (request: AuthRequest) => {
    const userId = request.user?.id;
    if (!userId) {
        throw new UserControllerError(401, 'Unauthorized');
    }

    const user = await User.findById(userId).select(
        'name email phone address role level balance points active createdAt updatedAt preferences password'
    );

    if (!user) {
        throw new UserControllerError(404, 'User tidak ditemukan');
    }

    if (user.active === false) {
        throw new UserControllerError(403, 'Akun tidak aktif');
    }

    return user;
};

const serializeMyProfile = (user: any): MyProfileResponse => ({
    id: user._id,
    name: user.name,
    email: user.email,
    phone: user.phone || '',
    address: user.address || '',
    role: user.role,
    level: user.level,
    balance: user.balance,
    points: user.points,
    active: user.active !== false,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    preferences: getMemberPreferences(user)
});

const ensureMemberUser = async (id: string) => {
    if (!mongoose.Types.ObjectId.isValid(id)) {
        throw new UserControllerError(400, 'ID user tidak valid');
    }

    const user = await User.findOne({ _id: id, role: 'member' }).select(MEMBER_SELECT_FIELDS + ' apiKey');
    if (!user) {
        throw new UserControllerError(404, 'User member tidak ditemukan');
    }

    return user;
};

const ensureCurrentMember = async (request: AuthRequest) => {
    const userId = request.user?.id;
    if (!userId) {
        throw new UserControllerError(401, 'Unauthorized');
    }

    if (request.user?.role !== 'member') {
        throw new UserControllerError(403, 'Hanya member yang dapat mengakses data ini');
    }

    const user = await User.findOne({ _id: userId, role: 'member' }).select(
        'name email phone address role level balance points active createdAt updatedAt preferences password'
    );

    if (!user) {
        throw new UserControllerError(404, 'User member tidak ditemukan');
    }

    return user;
};

const buildListSummary = async () => {
    const summary = await User.aggregate([
        { $match: { role: 'member' } },
        {
            $group: {
                _id: null,
                totalMembers: { $sum: 1 },
                activeMembers: {
                    $sum: {
                        $cond: [{ $eq: ['$active', false] }, 0, 1]
                    }
                },
                inactiveMembers: {
                    $sum: {
                        $cond: [{ $eq: ['$active', false] }, 1, 0]
                    }
                },
                totalBalance: { $sum: '$balance' }
            }
        }
    ]);

    if (summary.length === 0) {
        return {
            totalMembers: 0,
            activeMembers: 0,
            inactiveMembers: 0,
            totalBalance: 0
        };
    }

    return summary[0];
};

const getMemberNotAdjustableMessage = async (id: string, amount: number) => {
    if (!mongoose.Types.ObjectId.isValid(id)) {
        throw new UserControllerError(400, 'ID user tidak valid');
    }

    const user = await User.findOne({ _id: id, role: 'member' }).select('balance');
    if (!user) {
        throw new UserControllerError(404, 'User member tidak ditemukan');
    }

    if (user.balance < amount) {
        throw new UserControllerError(400, 'Saldo user tidak mencukupi untuk pengurangan ini');
    }

    throw new UserControllerError(400, 'Saldo user tidak bisa disesuaikan');
};

const adjustUserBalanceWithTransaction = async (
    userId: string,
    operatorId: string,
    amount: number,
    type: BalanceAdjustmentType,
    reason: string
) => {
    const session = await mongoose.startSession();

    try {
        let result: BalanceAdjustmentResult | null = null;

        await session.withTransaction(async () => {
            const user = await User.findOne({ _id: userId, role: 'member' })
                .select(MEMBER_SELECT_FIELDS)
                .session(session);

            if (!user) {
                throw new UserControllerError(404, 'User member tidak ditemukan');
            }

            const delta = type === 'add' ? amount : -amount;
            const balanceBefore = user.balance;
            const balanceAfter = balanceBefore + delta;

            if (balanceAfter < 0) {
                throw new UserControllerError(400, 'Saldo user tidak mencukupi untuk pengurangan ini');
            }

            user.balance = balanceAfter;
            await user.save({ session });

            await UserBalanceAdjustment.create([{
                user: user._id,
                adjustedBy: operatorId,
                type,
                amount,
                balanceBefore,
                balanceAfter,
                reason
            }], { session });

            result = {
                user: sanitizeMemberUser({
                    _id: user._id,
                    name: user.name,
                    email: user.email,
                    level: user.level,
                    balance: user.balance,
                    points: user.points,
                    active: user.active,
                    createdAt: user.createdAt,
                    updatedAt: user.updatedAt
                }),
                balanceBefore,
                balanceAfter
            };
        });

        if (!result) {
            throw new Error('Balance adjustment transaction did not complete');
        }

        return result;
    } finally {
        await session.endSession();
    }
};

const adjustUserBalanceWithCompensation = async (
    userId: string,
    operatorId: string,
    amount: number,
    type: BalanceAdjustmentType,
    reason: string
) => {
    const delta = type === 'add' ? amount : -amount;

    const filter: Record<string, unknown> = {
        _id: userId,
        role: 'member'
    };

    if (type === 'subtract') {
        filter.balance = { $gte: amount };
    }

    const updatedUser = await User.findOneAndUpdate(
        filter,
        { $inc: { balance: delta } },
        { new: true }
    ).select(MEMBER_SELECT_FIELDS);

    if (!updatedUser) {
        if (type === 'subtract') {
            await getMemberNotAdjustableMessage(userId, amount);
        }

        throw new UserControllerError(404, 'User member tidak ditemukan');
    }

    const balanceAfter = updatedUser.balance;
    const balanceBefore = balanceAfter - delta;

    try {
        await UserBalanceAdjustment.create({
            user: updatedUser._id,
            adjustedBy: operatorId,
            type,
            amount,
            balanceBefore,
            balanceAfter,
            reason
        });

        return {
            user: sanitizeMemberUser(updatedUser),
            balanceBefore,
            balanceAfter
        };
    } catch (error) {
        const rollback = await User.updateOne(
            { _id: updatedUser._id },
            { $inc: { balance: -delta } }
        );

        if (rollback.modifiedCount === 0) {
            console.error('Failed to roll back member balance adjustment after audit log failure');
        }

        throw error;
    }
};

export const getMyProfile = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const user = await ensureCurrentMember(request);
        return reply.send({
            profile: serializeMyProfile(user)
        });
    } catch (error) {
        if (error instanceof UserControllerError) {
            return reply.status(error.statusCode).send({ message: error.message });
        }

        console.error('Get my profile error:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const updateMyProfile = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const payload = request.body as UpdateMyProfilePayload;
        const user = await ensureCurrentMember(request);
        let hasChanges = false;

        if (typeof payload.name === 'string') {
            const name = payload.name.trim();
            if (name.length < 2 || name.length > 80) {
                return reply.status(400).send({ message: 'Nama harus 2-80 karakter' });
            }

            user.name = name;
            hasChanges = true;
        }

        if (typeof payload.email === 'string') {
            const email = normalizeEmail(payload.email);
            if (!isValidEmail(email)) {
                return reply.status(400).send({ message: 'Format email tidak valid' });
            }

            const existingUser = await User.findOne({
                email,
                _id: { $ne: user._id }
            }).select('_id');

            if (existingUser) {
                return reply.status(400).send({ message: 'Email sudah dipakai akun lain' });
            }

            user.email = email;
            hasChanges = true;
        }

        if (typeof payload.phone === 'string') {
            const phone = normalizePhone(payload.phone);
            if (phone && !isValidPhone(phone)) {
                return reply.status(400).send({ message: 'Nomor telepon harus 8-20 digit' });
            }

            user.phone = phone || undefined;
            hasChanges = true;
        }

        if (typeof payload.address === 'string') {
            const address = payload.address.trim();
            if (address.length > 200) {
                return reply.status(400).send({ message: 'Alamat maksimal 200 karakter' });
            }

            user.address = address || undefined;
            hasChanges = true;
        }

        if (!hasChanges) {
            return reply.status(400).send({ message: 'Tidak ada perubahan yang bisa disimpan' });
        }

        await user.save();

        return reply.send({
            message: 'Profil berhasil diperbarui',
            profile: serializeMyProfile(user)
        });
    } catch (error) {
        if (error instanceof UserControllerError) {
            return reply.status(error.statusCode).send({ message: error.message });
        }

        console.error('Update my profile error:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const changeMyPassword = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const payload = request.body as ChangeMyPasswordPayload;
        const user = await ensureCurrentMember(request);
        const currentPassword = payload.currentPassword || '';
        const newPassword = payload.newPassword || '';
        const confirmPassword = payload.confirmPassword || '';

        if (!currentPassword || !newPassword || !confirmPassword) {
            return reply.status(400).send({ message: 'Semua field password wajib diisi' });
        }

        if (!user.password) {
            return reply.status(400).send({ message: 'Akun ini belum memiliki password lokal' });
        }

        const isMatch = await bcrypt.compare(currentPassword, user.password);
        if (!isMatch) {
            return reply.status(400).send({ message: 'Password saat ini tidak sesuai' });
        }

        if (newPassword.length < 12) {
            return reply.status(400).send({ message: 'Password baru minimal 12 karakter' });
        }

        if (COMMON_PASSWORDS.has(newPassword.toLowerCase())) {
            return reply.status(400).send({ message: 'Password baru terlalu umum digunakan' });
        }

        if (newPassword !== confirmPassword) {
            return reply.status(400).send({ message: 'Konfirmasi password baru tidak cocok' });
        }

        if (newPassword === currentPassword) {
            return reply.status(400).send({ message: 'Password baru harus berbeda dari password saat ini' });
        }

        user.password = newPassword;
        user.sessionVersion = (user.sessionVersion || 0) + 1;
        await user.save();

        return reply.send({
            message: 'Password berhasil diubah'
        });
    } catch (error) {
        if (error instanceof UserControllerError) {
            return reply.status(error.statusCode).send({ message: error.message });
        }

        console.error('Change my password error:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const getMyPreferences = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const user = await ensureCurrentAuthenticatedUser(request);
        return reply.send({
            preferences: getMemberPreferences(user)
        });
    } catch (error) {
        if (error instanceof UserControllerError) {
            return reply.status(error.statusCode).send({ message: error.message });
        }

        console.error('Get my preferences error:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const updateMyPreferences = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const payload = request.body as UpdateMyPreferencesPayload;
        const user = await ensureCurrentAuthenticatedUser(request);
        const nextPreferences = {
            ...getMemberPreferences(user)
        };
        let hasChanges = false;

        if (typeof payload.emailNotifications === 'boolean') {
            nextPreferences.emailNotifications = payload.emailNotifications;
            hasChanges = true;
        }

        if (typeof payload.smsNotifications === 'boolean') {
            nextPreferences.smsNotifications = payload.smsNotifications;
            hasChanges = true;
        }

        if (typeof payload.showBalance === 'boolean') {
            nextPreferences.showBalance = payload.showBalance;
            hasChanges = true;
        }

        if (typeof payload.uiTheme === 'string') {
            if (!UI_THEME_VALUES.has(payload.uiTheme)) {
                return reply.status(400).send({ message: 'Tema UI tidak valid' });
            }

            nextPreferences.uiTheme = payload.uiTheme;
            hasChanges = true;
        }

        if (!hasChanges) {
            return reply.status(400).send({ message: 'Tidak ada preferensi yang bisa disimpan' });
        }

        user.preferences = nextPreferences;
        await user.save();

        return reply.send({
            message: 'Preferensi berhasil diperbarui',
            preferences: getMemberPreferences(user)
        });
    } catch (error) {
        if (error instanceof UserControllerError) {
            return reply.status(error.statusCode).send({ message: error.message });
        }

        console.error('Update my preferences error:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const getMyLoginActivity = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const user = await ensureCurrentMember(request);

        const logs = await LoginLog.find({
            user: user._id,
            status: 'success'
        })
            .select('_id ip userAgent createdAt')
            .sort({ createdAt: -1 })
            .limit(10)
            .lean();

        return reply.send({
            items: logs.map((log) => ({
                _id: log._id,
                ip: log.ip || '',
                userAgent: log.userAgent || '',
                createdAt: log.createdAt
            }))
        });
    } catch (error) {
        if (error instanceof UserControllerError) {
            return reply.status(error.statusCode).send({ message: error.message });
        }

        console.error('Get my login activity error:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const getUsers = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const query = request.query as QueryParams;
        const page = parsePositiveInt(query.page, 1, Number.MAX_SAFE_INTEGER);
        const limit = parsePositiveInt(query.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
        const skip = (page - 1) * limit;

        const filter: Record<string, unknown> = { role: 'member' };

        const search = query.search?.trim();
        if (search) {
            const pattern = escapeRegex(search);
            filter.$or = [
                { name: { $regex: pattern, $options: 'i' } },
                { email: { $regex: pattern, $options: 'i' } }
            ];
        }

        if (query.level && MEMBER_LEVELS.has(query.level as UserLevel)) {
            filter.level = query.level;
        }

        if (query.status === 'active') {
            filter.active = true;
        } else if (query.status === 'inactive') {
            filter.active = false;
        }

        const sortBy = ALLOWED_SORT_FIELDS.has(query.sortBy || '') ? query.sortBy! : 'createdAt';
        const sortOrder = query.sortOrder === 'asc' ? 1 : -1;

        const [users, totalUsers, summary] = await Promise.all([
            User.find(filter)
                .select(MEMBER_SELECT_FIELDS)
                .sort({ [sortBy]: sortOrder })
                .skip(skip)
                .limit(limit)
                .lean(),
            User.countDocuments(filter),
            buildListSummary()
        ]);

        const totalPages = Math.max(1, Math.ceil(totalUsers / limit));

        return reply.send({
            users: users.map((user) => sanitizeMemberUser(user as any)),
            currentPage: page,
            totalPages,
            totalUsers,
            pageSize: limit,
            summary
        });
    } catch (error) {
        console.error('Get users error:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const getUserById = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };
        const user = await ensureMemberUser(id);

        return reply.send({
            user: sanitizeMemberUser(user)
        });
    } catch (error) {
        if (error instanceof UserControllerError) {
            return reply.status(error.statusCode).send({ message: error.message });
        }

        console.error('Get user by id error:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const updateUser = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };
        const payload = request.body as UpdateUserPayload;
        const user = await ensureMemberUser(id);

        let hasChanges = false;

        if (typeof payload.name === 'string') {
            const name = payload.name.trim();
            if (name.length < 2 || name.length > 80) {
                return reply.status(400).send({ message: 'Nama user harus 2-80 karakter' });
            }

            user.name = name;
            hasChanges = true;
        }

        if (typeof payload.email === 'string') {
            const email = normalizeEmail(payload.email);
            if (!isValidEmail(email)) {
                return reply.status(400).send({ message: 'Format email tidak valid' });
            }

            const existingUser = await User.findOne({
                email,
                _id: { $ne: user._id }
            }).select('_id');

            if (existingUser) {
                return reply.status(400).send({ message: 'Email sudah dipakai akun lain' });
            }

            user.email = email;
            hasChanges = true;
        }

        if (typeof payload.level === 'string') {
            if (!MEMBER_LEVELS.has(payload.level)) {
                return reply.status(400).send({ message: 'Level user tidak valid' });
            }

            user.level = payload.level;
            hasChanges = true;
        }

        if (!hasChanges) {
            return reply.status(400).send({ message: 'Tidak ada perubahan yang bisa disimpan' });
        }

        await user.save();

        return reply.send({
            message: 'User berhasil diperbarui',
            user: sanitizeMemberUser(user)
        });
    } catch (error) {
        if (error instanceof UserControllerError) {
            return reply.status(error.statusCode).send({ message: error.message });
        }

        console.error('Update user error:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const updateUserStatus = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };
        const payload = request.body as UserStatusPayload;

        if (typeof payload.active !== 'boolean') {
            return reply.status(400).send({ message: 'Status aktif wajib diisi' });
        }

        const user = await ensureMemberUser(id);

        user.active = payload.active;
        if (!payload.active) {
            user.apiKey = undefined;
        }

        await user.save();

        return reply.send({
            message: payload.active ? 'User berhasil diaktifkan kembali' : 'User berhasil dinonaktifkan',
            user: sanitizeMemberUser(user)
        });
    } catch (error) {
        if (error instanceof UserControllerError) {
            return reply.status(error.statusCode).send({ message: error.message });
        }

        console.error('Update user status error:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const deleteUser = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };
        const user = await ensureMemberUser(id);

        user.active = false;
        user.apiKey = undefined;
        await user.save();

        return reply.send({
            message: 'User berhasil dinonaktifkan',
            user: sanitizeMemberUser(user)
        });
    } catch (error) {
        if (error instanceof UserControllerError) {
            return reply.status(error.statusCode).send({ message: error.message });
        }

        console.error('Deactivate user error:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const getUserBalanceAdjustments = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };
        const query = request.query as { limit?: string };
        const limit = parsePositiveInt(query.limit, 10, 50);

        await ensureMemberUser(id);

        const logs = await UserBalanceAdjustment.find({ user: id })
            .populate('adjustedBy', 'name email role')
            .sort({ createdAt: -1 })
            .limit(limit)
            .lean();

        return reply.send({
            items: logs
        });
    } catch (error) {
        if (error instanceof UserControllerError) {
            return reply.status(error.statusCode).send({ message: error.message });
        }

        console.error('Get user balance adjustments error:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const getMyBalanceHistory = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const userId = request.user?.id;
        const role = request.user?.role;

        if (!userId) {
            return reply.status(401).send({ message: 'Unauthorized' });
        }

        if (role !== 'member') {
            return reply.status(403).send({ message: 'Balance history hanya tersedia untuk member' });
        }

        const [approvedDeposits, successfulTransactions, redeemedVouchers, balanceAdjustments] = await Promise.all([
            Deposit.find({ user: userId, status: 'approved' })
                .select('_id amount adminFee createdAt')
                .lean(),
            Transaction.find({ user: userId, status: 'success' })
                .select('_id amount createdAt product')
                .populate('product', 'name code')
                .lean(),
            Voucher.find({ redeemedBy: userId, isRedeemed: true })
                .select('_id code amount redeemedAt createdAt redeemedBalanceBefore redeemedBalanceAfter')
                .lean(),
            UserBalanceAdjustment.find({ user: userId })
                .select('_id type amount reason balanceBefore balanceAfter createdAt adjustedBy')
                .populate('adjustedBy', 'name email')
                .lean()
        ]);

        const items: BalanceHistoryItem[] = [];

        approvedDeposits.forEach((deposit: {
            _id: mongoose.Types.ObjectId;
            amount?: number;
            adminFee?: number | null;
            createdAt: Date | string;
        }) => {
            const adminFee = Math.max(0, Number(deposit.adminFee ?? 0));
            const netAmount = Math.max(0, Number(deposit.amount ?? 0) - adminFee);

            if (netAmount <= 0) {
                return;
            }

            items.push({
                _id: deposit._id.toString(),
                source: 'deposit',
                type: 'credit',
                amount: netAmount,
                description: adminFee > 0
                    ? `Deposit saldo disetujui (fee Rp ${adminFee.toLocaleString('id-ID')})`
                    : 'Deposit saldo disetujui',
                reference: `DEP-${deposit._id.toString().slice(-8).toUpperCase()}`,
                createdAt: deposit.createdAt
            });
        });

        successfulTransactions.forEach((transaction: {
            _id: mongoose.Types.ObjectId;
            amount?: number;
            createdAt: Date | string;
            product?: unknown;
        }) => {
            const product = transaction.product as { name?: string; code?: string } | null;

            items.push({
                _id: transaction._id.toString(),
                source: 'purchase',
                type: 'debit',
                amount: Number(transaction.amount ?? 0),
                description: product?.name || 'Pembelian produk',
                reference: `TRX-${transaction._id.toString().slice(-8).toUpperCase()}`,
                createdAt: transaction.createdAt,
                meta: {
                    productCode: product?.code || null
                }
            });
        });

        redeemedVouchers.forEach((voucher: {
            _id: mongoose.Types.ObjectId;
            code: string;
            amount?: number;
            redeemedAt?: Date | string;
            createdAt: Date | string;
            redeemedBalanceBefore?: number;
            redeemedBalanceAfter?: number;
        }) => {
            items.push({
                _id: voucher._id.toString(),
                source: 'voucher',
                type: 'credit',
                amount: Number(voucher.amount ?? 0),
                description: `Redeem voucher ${voucher.code}`,
                reference: voucher.code,
                createdAt: voucher.redeemedAt || voucher.createdAt,
                balanceBefore: voucher.redeemedBalanceBefore,
                balanceAfter: voucher.redeemedBalanceAfter
            });
        });

        balanceAdjustments.forEach((adjustment: {
            _id: mongoose.Types.ObjectId;
            type: BalanceAdjustmentType;
            amount?: number;
            reason?: string;
            balanceBefore?: number;
            balanceAfter?: number;
            createdAt: Date | string;
            adjustedBy?: unknown;
        }) => {
            const adjustedBy = adjustment.adjustedBy as { name?: string; email?: string } | null;
            const itemType: BalanceHistoryItem['type'] = adjustment.type === 'add' ? 'credit' : 'debit';

            items.push({
                _id: adjustment._id.toString(),
                source: 'adjustment',
                type: itemType,
                amount: Number(adjustment.amount ?? 0),
                description: adjustment.reason || 'Penyesuaian saldo admin',
                reference: `ADJ-${adjustment._id.toString().slice(-8).toUpperCase()}`,
                createdAt: adjustment.createdAt,
                balanceBefore: adjustment.balanceBefore,
                balanceAfter: adjustment.balanceAfter,
                meta: {
                    adjustedBy: adjustedBy?.name || adjustedBy?.email || null
                }
            });
        });

        items.sort((left, right) => (
            new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
        ));

        return reply.send({
            items
        });
    } catch (error) {
        console.error('Get my balance history error:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const adjustUserBalance = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };
        const payload = request.body as BalanceAdjustmentPayload;
        const operatorId = request.user?.id;

        if (!operatorId) {
            return reply.status(401).send({ message: 'Unauthorized' });
        }

        const amount = Number(payload.amount);
        if (!Number.isFinite(amount) || amount <= 0) {
            return reply.status(400).send({ message: 'Nominal penyesuaian harus lebih besar dari 0' });
        }

        if (payload.type !== 'add' && payload.type !== 'subtract') {
            return reply.status(400).send({ message: 'Tipe penyesuaian saldo tidak valid' });
        }

        const reason = payload.reason?.trim();
        if (!reason || reason.length < 5 || reason.length > 300) {
            return reply.status(400).send({ message: 'Alasan penyesuaian saldo wajib 5-300 karakter' });
        }

        let result: BalanceAdjustmentResult;

        try {
            result = await adjustUserBalanceWithTransaction(id, operatorId, amount, payload.type, reason);
        } catch (error) {
            if (error instanceof UserControllerError) {
                throw error;
            }

            if (!isTransactionSupportError(error)) {
                throw error;
            }

            result = await adjustUserBalanceWithCompensation(id, operatorId, amount, payload.type, reason);
        }

        return reply.send({
            message: payload.type === 'add' ? 'Saldo user berhasil ditambahkan' : 'Saldo user berhasil dikurangi',
            user: result.user,
            audit: {
                amount,
                type: payload.type,
                reason,
                balanceBefore: result.balanceBefore,
                balanceAfter: result.balanceAfter
            }
        });
    } catch (error) {
        if (error instanceof UserControllerError) {
            return reply.status(error.statusCode).send({ message: error.message });
        }

        console.error('Adjust user balance error:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const createAdminUser = async (_request: AuthRequest, reply: FastifyReply) => {
    return reply.status(410).send({ message: 'Gunakan manajemen tim untuk membuat akun admin' });
};

export const makeUserAdmin = async (_request: AuthRequest, reply: FastifyReply) => {
    return reply.status(410).send({ message: 'Gunakan manajemen tim untuk promosi akun admin' });
};
