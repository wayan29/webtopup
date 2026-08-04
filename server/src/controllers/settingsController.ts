import { FastifyRequest, FastifyReply } from 'fastify';
import { Settings } from '../models';
import {
    defaultSiteSettings,
    getAllSiteSettings,
    getSiteSettings,
    isSiteSettingKey,
    publicSiteSettingKeys,
    siteSettingKeys,
    type SiteSettingKey,
    type SiteSettings
} from '../services/siteSettingsService';

class SettingsControllerError extends Error {
    statusCode: number;

    constructor(statusCode: number, message: string) {
        super(message);
        this.statusCode = statusCode;
    }
}

const allowedDateFormats = new Set([
    'DDMMYYYY',
    'YYYYMMDD',
    'MMDDYYYY',
    'DDMMYY',
    'YYMMDD',
    'NONE'
]);

const allowedSeparators = new Set(['', '-', '_']);
const allowedRandomTypes = new Set(['alphanumeric', 'numeric']);
const safePathOrUrlMessage = 'URL harus berupa http/https atau path internal yang diawali "/"';

const isRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
);

const normalizeText = (value: unknown) => (
    typeof value === 'string' ? value.trim() : ''
);

const ensureSafePathOrUrl = (value: unknown, fieldLabel: string) => {
    const normalized = normalizeText(value);

    if (!normalized) {
        return '';
    }

    if (normalized.startsWith('/')) {
        if (normalized.startsWith('//')) {
            throw new SettingsControllerError(400, `${fieldLabel} ${safePathOrUrlMessage}`);
        }

        return normalized;
    }

    try {
        const parsed = new URL(normalized);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            throw new Error('Invalid protocol');
        }

        return parsed.toString();
    } catch {
        throw new SettingsControllerError(400, `${fieldLabel} ${safePathOrUrlMessage}`);
    }
};

const ensureText = (value: unknown, fieldLabel: string, maxLength: number, fallback = '') => {
    const normalized = normalizeText(typeof value === 'undefined' ? fallback : value);

    if (normalized.length > maxLength) {
        throw new SettingsControllerError(400, `${fieldLabel} maksimal ${maxLength} karakter`);
    }

    return normalized;
};

const ensureBoolean = (value: unknown, fieldLabel: string) => {
    if (typeof value !== 'boolean') {
        throw new SettingsControllerError(400, `${fieldLabel} tidak valid`);
    }

    return value;
};

const ensureInteger = (
    value: unknown,
    fieldLabel: string,
    min: number,
    max: number
) => {
    const normalized = Number(value);

    if (!Number.isFinite(normalized)) {
        throw new SettingsControllerError(400, `${fieldLabel} harus berupa angka`);
    }

    if (!Number.isInteger(normalized)) {
        throw new SettingsControllerError(400, `${fieldLabel} harus berupa bilangan bulat`);
    }

    if (normalized < min || normalized > max) {
        throw new SettingsControllerError(400, `${fieldLabel} harus di antara ${min} sampai ${max}`);
    }

    return normalized;
};

const ensureOptionalEmail = (value: unknown, fieldLabel: string) => {
    const normalized = ensureText(value, fieldLabel, 120);

    if (!normalized) {
        return '';
    }

    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailPattern.test(normalized)) {
        throw new SettingsControllerError(400, `${fieldLabel} tidak valid`);
    }

    return normalized;
};

const ensureOptionalWhatsapp = (value: unknown) => {
    const normalized = ensureText(value, 'WhatsApp', 20);

    if (!normalized) {
        return '';
    }

    if (!/^\d{8,20}$/.test(normalized)) {
        throw new SettingsControllerError(400, 'WhatsApp harus berupa angka 8-20 digit tanpa spasi');
    }

    return normalized;
};

const ensureEnum = <T extends string>(
    value: unknown,
    fieldLabel: string,
    allowedValues: Set<T>
) => {
    const normalized = normalizeText(value) as T;

    if (!allowedValues.has(normalized)) {
        throw new SettingsControllerError(400, `${fieldLabel} tidak valid`);
    }

    return normalized;
};

const ensurePrefix = (value: unknown, fieldLabel: string) => {
    const normalized = ensureText(value, fieldLabel, 12).toUpperCase();

    if (normalized && !/^[A-Z0-9]+$/.test(normalized)) {
        throw new SettingsControllerError(400, `${fieldLabel} hanya boleh berisi huruf dan angka`);
    }

    return normalized;
};

const validateSettingValue = (
    key: SiteSettingKey,
    value: unknown
): SiteSettings[SiteSettingKey] => {
    switch (key) {
        case 'brand':
            return ensureText(value, 'Brand', 80);
        case 'title':
            return ensureText(value, 'Judul website', 120);
        case 'favicon':
            return ensureSafePathOrUrl(value, 'Favicon');
        case 'logo':
            return ensureSafePathOrUrl(value, 'Logo');
        case 'description':
            return ensureText(value, 'Deskripsi website', 300);
        case 'whatsapp':
            return ensureOptionalWhatsapp(value);
        case 'telegram':
            return ensureText(value, 'Telegram', 255);
        case 'email':
            return ensureOptionalEmail(value, 'Email');
        case 'instagram':
            return ensureText(value, 'Instagram', 255);
        case 'facebook':
            return ensureText(value, 'Facebook', 255);
        case 'twitter':
            return ensureText(value, 'Twitter / X', 255);
        case 'youtube':
            return ensureText(value, 'YouTube', 255);
        case 'address':
            return ensureText(value, 'Alamat', 500);
        case 'maintenanceMode':
            return ensureBoolean(value, 'Mode maintenance');
        case 'maintenanceMessage':
            return ensureText(value, 'Pesan maintenance', 500);
        case 'registrationEnabled':
            return ensureBoolean(value, 'Status registrasi');
        case 'guestCheckoutEnabled':
            return ensureBoolean(value, 'Status guest checkout');
        case 'minDeposit':
            return ensureInteger(value, 'Minimum deposit', 0, 100000000);
        case 'maxDeposit':
            return ensureInteger(value, 'Maximum deposit', 0, 100000000);
        case 'depositFee':
            return ensureInteger(value, 'Biaya deposit', 0, 100000000);
        case 'depositFeeType':
            return ensureEnum(value, 'Tipe biaya deposit', new Set(['fixed', 'percent']));
        case 'footerText':
            return ensureText(value, 'Teks footer', 200);
        case 'termsUrl':
            return ensureSafePathOrUrl(value, 'URL syarat & ketentuan');
        case 'privacyUrl':
            return ensureSafePathOrUrl(value, 'URL kebijakan privasi');
        case 'googleAnalyticsId':
            return ensureText(value, 'Google Analytics ID', 60).toUpperCase();
        case 'facebookPixelId':
            return ensureText(value, 'Facebook Pixel ID', 60);
        case 'popupBannerEnabled':
            return ensureBoolean(value, 'Status popup banner');
        case 'popupBannerImage':
            return ensureSafePathOrUrl(value, 'Gambar popup banner');
        case 'popupBannerLink':
            return ensureSafePathOrUrl(value, 'Link popup banner');
        case 'popupBannerTitle':
            return ensureText(value, 'Judul popup banner', 120);
        case 'popupBannerDescription':
            return ensureText(value, 'Deskripsi popup banner', 300);
        case 'refIdPrefix':
            return ensurePrefix(value, 'Prefix Ref ID');
        case 'refIdDateFormat':
            return ensureEnum(value, 'Format tanggal Ref ID', allowedDateFormats);
        case 'refIdSeparator':
            return ensureEnum(value, 'Separator Ref ID', allowedSeparators);
        case 'refIdSequenceDigits':
            return ensureInteger(value, 'Digit sequence Ref ID', 1, 10);
        case 'invoicePrefix':
            return ensurePrefix(value, 'Prefix invoice');
        case 'invoiceDateFormat':
            return ensureEnum(value, 'Format tanggal invoice', allowedDateFormats);
        case 'invoiceSeparator':
            return ensureEnum(value, 'Separator invoice', allowedSeparators);
        case 'invoiceRandomLength':
            return ensureInteger(value, 'Panjang random invoice', 1, 12);
        case 'invoiceRandomType':
            return ensureEnum(value, 'Tipe random invoice', allowedRandomTypes);
        default:
            return value as SiteSettings[SiteSettingKey];
    }
};

const handleSettingsError = (reply: FastifyReply, error: unknown) => {
    console.error('Settings controller error:', error);

    if (error instanceof SettingsControllerError) {
        return reply.status(error.statusCode).send({ message: error.message });
    }

    return reply.status(500).send({ message: 'Internal Server Error' });
};

const validateUpdatePayload = async (payload: Record<string, unknown>) => {
    const invalidKeys = Object.keys(payload).filter((key) => !isSiteSettingKey(key));
    if (invalidKeys.length > 0) {
        throw new SettingsControllerError(
            400,
            `Key pengaturan tidak dikenali: ${invalidKeys.join(', ')}`
        );
    }

    const currentSettings = await getAllSiteSettings();
    const nextSettings = { ...currentSettings };
    const changedValues: Partial<Record<SiteSettingKey, SiteSettings[SiteSettingKey]>> = {};

    for (const [key, value] of Object.entries(payload)) {
        if (!isSiteSettingKey(key)) {
            continue;
        }

        const normalizedValue = validateSettingValue(key, value);
        (nextSettings as Record<SiteSettingKey, SiteSettings[SiteSettingKey]>)[key] = normalizedValue;
        changedValues[key] = normalizedValue;
    }

    if (nextSettings.maxDeposit < nextSettings.minDeposit) {
        throw new SettingsControllerError(400, 'Maximum deposit tidak boleh lebih kecil dari minimum deposit');
    }

    if (nextSettings.depositFeeType === 'percent' && nextSettings.depositFee > 100) {
        throw new SettingsControllerError(400, 'Biaya deposit persentase tidak boleh lebih dari 100%');
    }

    if (nextSettings.maintenanceMode && !nextSettings.maintenanceMessage) {
        throw new SettingsControllerError(400, 'Pesan maintenance wajib diisi saat maintenance aktif');
    }

    if (nextSettings.popupBannerEnabled && !nextSettings.popupBannerImage) {
        throw new SettingsControllerError(400, 'Gambar popup banner wajib diisi saat popup aktif');
    }

    return {
        currentSettings,
        nextSettings,
        changedValues
    };
};

// Public - Get public settings
export const getPublicSettings = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const settings = await getSiteSettings(publicSiteSettingKeys);
        return reply.send(settings);
    } catch (error) {
        return handleSettingsError(reply, error);
    }
};

// Admin - Get all settings
export const getAllSettings = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const settings = await getAllSiteSettings();
        return reply.send(settings);
    } catch (error) {
        return handleSettingsError(reply, error);
    }
};

// Admin - Update settings
export const updateSettings = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const updates = request.body as Record<string, any>;

        if (!isRecord(updates)) {
            throw new SettingsControllerError(400, 'Invalid request body');
        }

        const { changedValues, nextSettings } = await validateUpdatePayload(updates);

        const bulkOps = Object.entries(changedValues).map(([key, value]) => ({
            updateOne: {
                filter: { key },
                update: { $set: { key, value } },
                upsert: true
            }
        }));

        if (bulkOps.length > 0) {
            await Settings.bulkWrite(bulkOps);
        }

        return reply.send({
            success: true,
            message: 'Settings updated successfully',
            data: nextSettings
        });
    } catch (error) {
        return handleSettingsError(reply, error);
    }
};

// Admin - Get single setting
export const getSetting = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { key } = request.params as { key: string };

        if (!isSiteSettingKey(key)) {
            return reply.status(404).send({ message: 'Setting not found' });
        }

        const setting = await getSiteSettings([key]);
        return reply.send({ key, value: setting[key] });
    } catch (error) {
        return handleSettingsError(reply, error);
    }
};

// Admin - Set single setting
export const setSetting = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { key } = request.params as { key: string };
        const { value } = request.body as { value: any };

        if (!isSiteSettingKey(key)) {
            return reply.status(404).send({ message: 'Setting not found' });
        }

        const { nextSettings, changedValues } = await validateUpdatePayload({ [key]: value });
        const normalizedValue = changedValues[key];

        await Settings.findOneAndUpdate(
            { key },
            { $set: { key, value: normalizedValue } },
            { upsert: true, new: true }
        );

        return reply.send({
            success: true,
            message: 'Setting updated',
            key,
            value: nextSettings[key]
        });
    } catch (error) {
        return handleSettingsError(reply, error);
    }
};
