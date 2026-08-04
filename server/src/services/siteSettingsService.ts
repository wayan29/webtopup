import { Settings } from '../models';

export const defaultSiteSettings = {
    brand: 'Danayasa',
    title: 'Danayasa - Top Up Game Termurah',
    favicon: '/danayasa-favicon.svg',
    logo: '/danayasa-logo.svg',
    description: 'Topup Game Terlengkap & Termurah',
    whatsapp: '',
    telegram: '',
    email: '',
    instagram: '',
    facebook: '',
    twitter: '',
    youtube: '',
    address: '',
    maintenanceMode: false,
    maintenanceMessage: 'Sistem sedang dalam pemeliharaan. Silakan coba beberapa saat lagi.',
    registrationEnabled: true,
    guestCheckoutEnabled: true,
    minDeposit: 10000,
    maxDeposit: 10000000,
    depositFee: 0,
    depositFeeType: 'fixed' as 'fixed' | 'percent',
    footerText: '© 2026 Danayasa. All Rights Reserved.',
    termsUrl: '',
    privacyUrl: '',
    googleAnalyticsId: '',
    facebookPixelId: '',
    popupBannerEnabled: false,
    popupBannerImage: '',
    popupBannerLink: '',
    popupBannerTitle: '',
    popupBannerDescription: '',
    refIdPrefix: 'REF',
    refIdDateFormat: 'DDMMYYYY',
    refIdSeparator: '',
    refIdSequenceDigits: 4,
    invoicePrefix: 'INV',
    invoiceDateFormat: 'YYYYMMDD',
    invoiceSeparator: '',
    invoiceRandomLength: 6,
    invoiceRandomType: 'alphanumeric'
};

export type SiteSettings = typeof defaultSiteSettings;
export type SiteSettingKey = keyof SiteSettings;

export const siteSettingKeys = Object.keys(defaultSiteSettings) as SiteSettingKey[];

export const publicSiteSettingKeys: SiteSettingKey[] = [
    'brand',
    'title',
    'favicon',
    'logo',
    'description',
    'whatsapp',
    'telegram',
    'email',
    'instagram',
    'facebook',
    'twitter',
    'youtube',
    'maintenanceMode',
    'maintenanceMessage',
    'registrationEnabled',
    'guestCheckoutEnabled',
    'footerText',
    'termsUrl',
    'privacyUrl',
    'popupBannerEnabled',
    'popupBannerImage',
    'popupBannerLink',
    'popupBannerTitle',
    'popupBannerDescription'
];

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

const normalizeText = (value: unknown) => (
    typeof value === 'string' ? value.trim() : ''
);

const normalizeBoolean = (value: unknown, fallback: boolean) => (
    typeof value === 'boolean' ? value : fallback
);

const normalizeInteger = (
    value: unknown,
    fallback: number,
    min: number,
    max: number
) => {
    const normalized = Number(value);

    if (!Number.isFinite(normalized)) {
        return fallback;
    }

    return Math.min(max, Math.max(min, Math.floor(normalized)));
};

const normalizeUrlOrPath = (value: unknown, fallback: string) => {
    const normalized = normalizeText(value);

    if (!normalized) {
        return fallback;
    }

    if (normalized.startsWith('/')) {
        return normalized.startsWith('//') ? fallback : normalized;
    }

    try {
        const parsed = new URL(normalized);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:'
            ? parsed.toString()
            : fallback;
    } catch {
        return fallback;
    }
};

const normalizeEnum = <T extends string>(
    value: unknown,
    fallback: T,
    allowedValues: Set<T>
) => {
    const normalized = normalizeText(value) as T;
    return allowedValues.has(normalized) ? normalized : fallback;
};

const normalizeSiteSettingValue = (
    key: SiteSettingKey,
    value: unknown
): SiteSettings[SiteSettingKey] => {
    const fallback = defaultSiteSettings[key];

    switch (key) {
        case 'maintenanceMode':
        case 'registrationEnabled':
        case 'guestCheckoutEnabled':
        case 'popupBannerEnabled':
            return normalizeBoolean(value, fallback as boolean);
        case 'minDeposit':
            return normalizeInteger(value, fallback as number, 0, 100000000);
        case 'maxDeposit':
            return normalizeInteger(value, fallback as number, 0, 100000000);
        case 'depositFee':
            return normalizeInteger(value, fallback as number, 0, 100000000);
        case 'refIdSequenceDigits':
            return normalizeInteger(value, fallback as number, 1, 10);
        case 'invoiceRandomLength':
            return normalizeInteger(value, fallback as number, 1, 12);
        case 'depositFeeType':
            return normalizeEnum(value, fallback as 'fixed' | 'percent', new Set(['fixed', 'percent']));
        case 'refIdDateFormat':
        case 'invoiceDateFormat':
            return normalizeEnum(value, fallback as string, allowedDateFormats);
        case 'refIdSeparator':
        case 'invoiceSeparator':
            return normalizeEnum(value, fallback as string, allowedSeparators);
        case 'invoiceRandomType':
            return normalizeEnum(value, fallback as string, allowedRandomTypes);
        case 'favicon':
        case 'logo':
        case 'popupBannerImage':
        case 'termsUrl':
        case 'privacyUrl':
        case 'popupBannerLink':
            return normalizeUrlOrPath(value, fallback as string);
        default:
            return normalizeText(typeof value === 'undefined' || value === null ? fallback : value);
    }
};

const normalizeSiteSettingsRecord = (source: Partial<Record<SiteSettingKey, unknown>>) => {
    const normalized = {} as SiteSettings;

    for (const key of siteSettingKeys) {
        normalized[key] = normalizeSiteSettingValue(key, source[key]) as never;
    }

    if (normalized.maxDeposit < normalized.minDeposit) {
        normalized.maxDeposit = normalized.minDeposit;
    }

    if (normalized.depositFeeType === 'percent') {
        normalized.depositFee = Math.min(normalized.depositFee, 100);
    }

    return normalized;
};

export const isSiteSettingKey = (value: string): value is SiteSettingKey =>
    siteSettingKeys.includes(value as SiteSettingKey);

export const getSiteSettings = async <K extends SiteSettingKey>(
    keys: readonly K[]
): Promise<Pick<SiteSettings, K>> => {
    const settings = await Settings.find({ key: { $in: keys as readonly string[] } }).lean();
    const rawRecord: Partial<Record<SiteSettingKey, unknown>> = {};

    for (const setting of settings) {
        if (isSiteSettingKey(setting.key)) {
            rawRecord[setting.key] = setting.value;
        }
    }

    const normalized = normalizeSiteSettingsRecord(rawRecord);
    const result = {} as Pick<SiteSettings, K>;

    for (const key of keys) {
        result[key] = normalized[key];
    }

    return result;
};

export const getAllSiteSettings = async () => getSiteSettings(siteSettingKeys);
