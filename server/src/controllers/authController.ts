import { FastifyRequest, FastifyReply } from 'fastify';
import bcrypt from 'bcrypt';
import { User, LoginLog } from '../models';
import { AuthRequest } from '../middlewares/authMiddleware';
import { getSiteSettings } from '../services/siteSettingsService';
import { buildMaintenanceMessage } from '../utils/siteSettingsRuntime';
import { getRequestClientIp } from '../utils/requestIp';
import { signJwtToken, verifyJwtToken } from '../utils/jwt';
import { generateSecret, generateURI, verifySync } from 'otplib';
import qrcode from 'qrcode';
import { sendAuthError } from '../utils/authErrors';

const TWO_FACTOR_ROLES = new Set(['owner', 'admin', 'cs']);
const TWO_FACTOR_PENDING_TTL_MS = 10 * 60 * 1000;
const TWO_FACTOR_ACTION_WINDOW_MS = 15 * 60 * 1000;
const TWO_FACTOR_ACTION_MAX_ATTEMPTS = 5;
const TWO_FACTOR_ACTION_BLOCK_MS = 15 * 60 * 1000;

type TwoFactorActionBucket = {
    hits: number[];
    blockedUntil?: number;
};

const twoFactorActionBuckets = new Map<string, TwoFactorActionBucket>();

const normalizeText = (value: unknown) => (
    typeof value === 'string' ? value.trim() : ''
);

const normalizeEmail = (value: unknown) => normalizeText(value).toLowerCase();
const INVALID_LOGIN_MESSAGE = 'Login gagal. Periksa email dan password Anda.';
const INVALID_REGISTER_MESSAGE = 'Registrasi tidak dapat diproses. Periksa data dan coba lagi.';
const COMMON_PASSWORDS = new Set([
    'password',
    'password123',
    '12345678',
    '123456789',
    '1234567890',
    'qwerty123',
    'admin123'
]);

const getPasswordValidationMessage = (password: string) => {
    if (password.length < 12) {
        return 'Password minimal 12 karakter';
    }

    if (COMMON_PASSWORDS.has(password.toLowerCase())) {
        return 'Password terlalu umum. Gunakan password yang lebih kuat';
    }

    return null;
};

const getAuthValidationError = (error: unknown): string | null => {
    if (!error || typeof error !== 'object') {
        return null;
    }

    const err = error as {
        code?: number;
        name?: string;
        message?: string;
        errors?: Record<string, { message?: string }>;
    };

    if (err.code === 11000) {
        return INVALID_REGISTER_MESSAGE;
    }

    if (err.name === 'ValidationError' && err.errors) {
        const firstError = Object.values(err.errors)[0];
        return firstError?.message || 'Data registrasi tidak valid';
    }

    return null;
};

const getMemberPreferences = (user: any) => ({
    emailNotifications: user?.preferences?.emailNotifications !== false,
    smsNotifications: user?.preferences?.smsNotifications === true,
    showBalance: user?.preferences?.showBalance !== false,
    uiTheme: user?.preferences?.uiTheme || 'ember-premium'
});

const serializeAuthUser = (user: any) => ({
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
    twoFactorEnabled: user.twoFactorEnabled === true,
    createdAt: user.createdAt,
    preferences: getMemberPreferences(user),
    permissions: user.permissions
});

const canUseTwoFactor = (role: string) => TWO_FACTOR_ROLES.has(role);

const normalizeOtpCode = (value: unknown) => normalizeText(value).replace(/\s+/g, '');
const isExpiredTwoFactorPendingSecret = (pendingAt?: Date) => !pendingAt || Date.now() - pendingAt.getTime() > TWO_FACTOR_PENDING_TTL_MS;

const hitTwoFactorActionBucket = (userId: string, action: string) => {
    const now = Date.now();
    const key = `${action}:${userId}`;
    const bucket = twoFactorActionBuckets.get(key) || { hits: [] };
    bucket.hits = bucket.hits.filter((timestamp) => now - timestamp < TWO_FACTOR_ACTION_WINDOW_MS);

    if (bucket.blockedUntil && bucket.blockedUntil <= now) {
        delete bucket.blockedUntil;
    }

    if (bucket.blockedUntil && bucket.blockedUntil > now) {
        twoFactorActionBuckets.set(key, bucket);
        return bucket.blockedUntil;
    }

    bucket.hits.push(now);
    if (bucket.hits.length > TWO_FACTOR_ACTION_MAX_ATTEMPTS) {
        bucket.blockedUntil = now + TWO_FACTOR_ACTION_BLOCK_MS;
        twoFactorActionBuckets.set(key, bucket);
        return bucket.blockedUntil;
    }

    twoFactorActionBuckets.set(key, bucket);
    return null;
};

const clearTwoFactorActionBucket = (userId: string, action: string) => {
    twoFactorActionBuckets.delete(`${action}:${userId}`);
};

const isValidTotpCode = (code: string, secret: string) => (
    verifySync({ token: code, secret }).valid === true
);

const buildAuthPayload = (user: any) => ({
    id: user._id,
    email: user.email,
    role: user.role,
    level: user.level,
    sessionVersion: user.sessionVersion || 0
});

const buildAuthResponse = (user: any) => ({
    message: 'Login successful',
    token: signJwtToken(buildAuthPayload(user), { expiresIn: '1h' }),
    user: serializeAuthUser(user)
});

const getClientInfo = (request: FastifyRequest) => {
    const ip = getRequestClientIp(request);
    const userAgentHeader = request.headers['user-agent'];
    const userAgent = Array.isArray(userAgentHeader) ? userAgentHeader[0] : (userAgentHeader || '');
    return { ip, userAgent };
};

export const register = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { name, email, password } = request.body as any;
        const settings = await getSiteSettings(['maintenanceMode', 'maintenanceMessage', 'registrationEnabled']);
        const normalizedName = normalizeText(name);
        const normalizedEmail = normalizeEmail(email);
        const normalizedPassword = typeof password === 'string' ? password : '';

        if (settings.maintenanceMode) {
            return reply.status(503).send({ message: buildMaintenanceMessage(settings.maintenanceMessage) });
        }

        if (!settings.registrationEnabled) {
            return reply.status(403).send({ message: 'Registrasi member sedang dinonaktifkan' });
        }

        if (normalizedName.length < 2) {
            return reply.status(400).send({ message: 'Nama minimal 2 karakter' });
        }

        if (!normalizedEmail) {
            return reply.status(400).send({ message: 'Email wajib diisi' });
        }

        const passwordValidationMessage = getPasswordValidationMessage(normalizedPassword);
        if (passwordValidationMessage) {
            return reply.status(400).send({ message: passwordValidationMessage });
        }

        const existingUser = await User.findOne({ email: normalizedEmail });
        if (existingUser) {
            return reply.status(400).send({ message: INVALID_REGISTER_MESSAGE });
        }

        const user = await User.create({
            name: normalizedName,
            email: normalizedEmail,
            password: normalizedPassword,
            role: 'member',
            level: 'basic',
            balance: 0
        });

        return reply.status(201).send({
            message: 'User registered successfully',
            token: signJwtToken(buildAuthPayload(user), { expiresIn: '1h' }),
            user: serializeAuthUser(user)
        });
    } catch (error) {
        console.error(error);
        const validationMessage = getAuthValidationError(error);
        if (validationMessage) {
            return reply.status(400).send({ message: validationMessage });
        }
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const login = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { email, password } = request.body as any;
        const { ip, userAgent } = getClientInfo(request);
        const normalizedEmail = normalizeEmail(email);
        const normalizedPassword = typeof password === 'string' ? password : '';

        if (!normalizedEmail || !normalizedPassword) {
            return reply.status(400).send({ message: 'Email dan password wajib diisi' });
        }

        const user = await User.findOne({ email: normalizedEmail });
        if (!user) {
            await LoginLog.create({
                user: null,
                email: normalizedEmail,
                role: null,
                ip,
                userAgent,
                status: 'failed',
                failReason: 'User not found'
            });
            return reply.status(400).send({ message: INVALID_LOGIN_MESSAGE });
        }

        if (!user.password) {
            await LoginLog.create({
                user: user._id,
                email: normalizedEmail,
                role: user.role,
                ip,
                userAgent,
                status: 'failed',
                failReason: 'No password set'
            });
            return reply.status(400).send({ message: INVALID_LOGIN_MESSAGE });
        }

        if (user.active === false) {
            await LoginLog.create({
                user: user._id,
                email: normalizedEmail,
                role: user.role,
                ip,
                userAgent,
                status: 'failed',
                failReason: 'Account inactive'
            });
            return reply.status(400).send({ message: INVALID_LOGIN_MESSAGE });
        }

        const isMatch = await bcrypt.compare(normalizedPassword, user.password);
        if (!isMatch) {
            await LoginLog.create({
                user: user._id,
                email: normalizedEmail,
                role: user.role,
                ip,
                userAgent,
                status: 'failed',
                failReason: 'Invalid password'
            });
            return reply.status(400).send({ message: INVALID_LOGIN_MESSAGE });
        }

        if (user.twoFactorEnabled === true && canUseTwoFactor(user.role)) {
            const challengeToken = signJwtToken({
                id: user._id,
                purpose: '2fa-login',
                sessionVersion: user.sessionVersion || 0
            }, { expiresIn: '5m' });

            return reply.send({
                message: 'Two-factor verification required',
                requiresTwoFactor: true,
                challengeToken
            });
        }

        await LoginLog.create({
            user: user._id,
            email: normalizedEmail,
            role: user.role,
            ip,
            userAgent,
            status: 'success'
        });

        return reply.send(buildAuthResponse(user));
    } catch (error) {
        console.error(error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const verifyTwoFactorLogin = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { challengeToken, code } = request.body as any;
        const normalizedCode = normalizeOtpCode(code);
        const { ip, userAgent } = getClientInfo(request);

        if (!challengeToken || !normalizedCode) {
            return reply.status(400).send({ message: 'Token verifikasi dan kode OTP wajib diisi' });
        }

        let decoded: any;
        try {
            decoded = verifyJwtToken<any>(challengeToken);
        } catch (error) {
            return reply.status(401).send({ message: 'Sesi verifikasi 2FA tidak valid atau sudah kedaluwarsa' });
        }

        if (decoded.purpose !== '2fa-login' || !decoded.id) {
            return reply.status(401).send({ message: 'Sesi verifikasi 2FA tidak valid' });
        }

        const user = await User.findById(decoded.id).select('+twoFactorSecret');
        if (!user || user.active === false || !user.twoFactorEnabled || !user.twoFactorSecret) {
            return reply.status(401).send({ message: 'Verifikasi 2FA tidak tersedia' });
        }

        const tokenSessionVersion = Number.isFinite(decoded.sessionVersion) ? decoded.sessionVersion : 0;
        if (tokenSessionVersion !== (user.sessionVersion || 0)) {
            return reply.status(401).send({ message: 'Sesi verifikasi 2FA tidak valid atau sudah kedaluwarsa' });
        }

        if (!isValidTotpCode(normalizedCode, user.twoFactorSecret)) {
            await LoginLog.create({
                user: user._id,
                email: user.email,
                role: user.role,
                ip,
                userAgent,
                status: 'failed',
                failReason: 'Invalid 2FA code'
            });
            return reply.status(400).send({ message: 'Kode OTP tidak valid' });
        }

        await LoginLog.create({
            user: user._id,
            email: user.email,
            role: user.role,
            ip,
            userAgent,
            status: 'success'
        });

        return reply.send(buildAuthResponse(user));
    } catch (error) {
        console.error(error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const getTwoFactorStatus = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const userId = request.user?.id;
        if (!userId) {
            return reply.status(401).send({ message: 'Unauthorized' });
        }

        const user = await User.findById(userId).select('role twoFactorEnabled');
        if (!user) {
            return reply.status(404).send({ message: 'User not found' });
        }

        if (!canUseTwoFactor(user.role)) {
            return reply.status(403).send({ message: '2FA hanya tersedia untuk owner, admin, dan CS' });
        }

        return reply.send({ enabled: user.twoFactorEnabled === true });
    } catch (error) {
        console.error(error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const setupTwoFactor = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const userId = request.user?.id;
        if (!userId) {
            return reply.status(401).send({ message: 'Unauthorized' });
        }

        const user = await User.findById(userId).select('+twoFactorPendingSecret +twoFactorSecret +twoFactorPendingAt');
        if (!user) {
            return reply.status(404).send({ message: 'User not found' });
        }

        if (!canUseTwoFactor(user.role)) {
            return reply.status(403).send({ message: '2FA hanya tersedia untuk owner, admin, dan CS' });
        }

        if (user.twoFactorEnabled) {
            return reply.status(400).send({ message: '2FA sudah aktif' });
        }

        const secret = generateSecret();
        user.twoFactorPendingSecret = secret;
        user.twoFactorPendingAt = new Date();
        await user.save();

        const issuer = process.env.APP_NAME?.trim() || 'PPOB Admin';
        const otpauthUrl = generateURI({ issuer, label: user.email, secret });
        const qrCodeDataUrl = await qrcode.toDataURL(otpauthUrl);

        return reply.send({
            secret,
            otpauthUrl,
            qrCodeDataUrl
        });
    } catch (error) {
        console.error(error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const confirmTwoFactor = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const userId = request.user?.id;
        const code = normalizeOtpCode((request.body as any)?.code);

        if (!userId) {
            return reply.status(401).send({ message: 'Unauthorized' });
        }

        if (!code) {
            return reply.status(400).send({ message: 'Kode OTP wajib diisi' });
        }

        const user = await User.findById(userId).select('+twoFactorPendingSecret +twoFactorSecret +twoFactorPendingAt');
        if (!user) {
            return reply.status(404).send({ message: 'User not found' });
        }

        if (!canUseTwoFactor(user.role)) {
            return reply.status(403).send({ message: '2FA hanya tersedia untuk owner, admin, dan CS' });
        }

        if (!user.twoFactorPendingSecret || isExpiredTwoFactorPendingSecret(user.twoFactorPendingAt)) {
            user.twoFactorPendingSecret = undefined;
            user.twoFactorPendingAt = undefined;
            await user.save();
            return reply.status(400).send({ message: 'Setup 2FA sudah kedaluwarsa. Mulai ulang setup.' });
        }

        const blockedUntil = hitTwoFactorActionBucket(userId, 'confirm-2fa');
        if (blockedUntil) {
            reply.header('Retry-After', String(Math.ceil((blockedUntil - Date.now()) / 1000)));
            return reply.status(429).send({ message: 'Terlalu banyak percobaan OTP. Coba lagi beberapa menit lagi.' });
        }

        if (!isValidTotpCode(code, user.twoFactorPendingSecret)) {
            return reply.status(400).send({ message: 'Kode OTP tidak valid' });
        }

        user.twoFactorSecret = user.twoFactorPendingSecret;
        user.twoFactorPendingSecret = undefined;
        user.twoFactorPendingAt = undefined;
        user.twoFactorEnabled = true;
        user.sessionVersion = (user.sessionVersion || 0) + 1;
        await user.save();
        clearTwoFactorActionBucket(userId, 'confirm-2fa');

        return reply.send({ message: '2FA berhasil diaktifkan. Silakan login ulang untuk melanjutkan.', enabled: true, requiresRelogin: true });
    } catch (error) {
        console.error(error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const disableTwoFactor = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const userId = request.user?.id;
        const body = request.body as { code?: unknown; password?: unknown } | undefined;
        const code = normalizeOtpCode(body?.code);
        const password = normalizeText(body?.password);

        if (!userId) {
            return reply.status(401).send({ message: 'Unauthorized' });
        }

        const user = await User.findById(userId).select('+twoFactorSecret +twoFactorPendingSecret +twoFactorPendingAt');
        if (!user) {
            return reply.status(404).send({ message: 'User not found' });
        }

        if (!canUseTwoFactor(user.role)) {
            return reply.status(403).send({ message: '2FA hanya tersedia untuk owner, admin, dan CS' });
        }

        if (!password) {
            return reply.status(400).send({ message: 'Password wajib diisi untuk menonaktifkan 2FA' });
        }

        const passwordValid = await user.comparePassword(password);
        if (!passwordValid) {
            return sendAuthError(reply, 400, 'REAUTH_PASSWORD_INVALID', 'Password tidak valid');
        }

        if (user.twoFactorEnabled && !user.twoFactorSecret) {
            return reply.status(409).send({ message: 'Konfigurasi 2FA tidak valid. Hubungi owner untuk reset 2FA.' });
        }

        if (user.twoFactorEnabled && user.twoFactorSecret) {
            if (!code) {
                return reply.status(400).send({ message: 'Kode OTP wajib diisi untuk menonaktifkan 2FA' });
            }

            const blockedUntil = hitTwoFactorActionBucket(userId, 'disable-2fa');
            if (blockedUntil) {
                reply.header('Retry-After', String(Math.ceil((blockedUntil - Date.now()) / 1000)));
                return reply.status(429).send({ message: 'Terlalu banyak percobaan OTP. Coba lagi beberapa menit lagi.' });
            }

            if (!isValidTotpCode(code, user.twoFactorSecret)) {
                return sendAuthError(reply, 400, 'REAUTH_OTP_INVALID', 'Kode OTP tidak valid');
            }
        }

        user.twoFactorEnabled = false;
        user.twoFactorSecret = undefined;
        user.twoFactorPendingSecret = undefined;
        user.twoFactorPendingAt = undefined;
        await user.save();
        clearTwoFactorActionBucket(userId, 'disable-2fa');

        return reply.send({ message: '2FA berhasil dinonaktifkan', enabled: false });
    } catch (error) {
        console.error(error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const revokeMySessions = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const userId = request.user?.id;
        if (!userId) {
            return reply.status(401).send({ message: 'Unauthorized' });
        }

        const user = await User.findByIdAndUpdate(
            userId,
            { $inc: { sessionVersion: 1 } },
            { new: true }
        );

        if (!user) {
            return reply.status(404).send({ message: 'User not found' });
        }

        return reply.send({ message: 'Semua sesi aktif berhasil dicabut. Silakan login ulang.' });
    } catch (error) {
        console.error(error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const me = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const userId = request.user?.id;

        if (!userId) {
            return reply.status(401).send({ message: 'Unauthorized' });
        }

        const user = await User.findById(userId);

        if (!user) {
            return reply.status(404).send({ message: 'User not found' });
        }

        return reply.send({
            user: serializeAuthUser(user)
        });
    } catch (error) {
        console.error(error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};
