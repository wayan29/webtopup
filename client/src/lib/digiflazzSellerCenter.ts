export type SellerCenterSection = 'overview' | 'settings' | 'mappings' | 'orders' | 'irs';

export const SELLER_CENTER_SECTIONS: readonly SellerCenterSection[] = [
    'overview',
    'settings',
    'mappings',
    'orders',
    'irs',
];

export const SELLER_CENTER_PATH = '/admin/addons/digiflazz-seller-center';
const LEGACY_DIGIFLAZZ_PATH = '/admin/addons/digiflazz-seller';
const LEGACY_IRS_PATH = '/admin/addons/irs-seller';

export const parseSellerCenterSection = (value: unknown): SellerCenterSection =>
    typeof value === 'string' && (SELLER_CENTER_SECTIONS as readonly string[]).includes(value)
        ? (value as SellerCenterSection)
        : 'overview';

export const legacySellerCenterDestination = (pathname: string): string => {
    if (pathname === LEGACY_IRS_PATH || pathname.startsWith(`${LEGACY_IRS_PATH}/`)) {
        return `${SELLER_CENTER_PATH}?section=irs`;
    }
    if (pathname === LEGACY_DIGIFLAZZ_PATH || pathname.startsWith(`${LEGACY_DIGIFLAZZ_PATH}/`)) {
        return `${SELLER_CENTER_PATH}?section=overview`;
    }
    return SELLER_CENTER_PATH;
};

export type SellerCenterStatus = 'ready' | 'disabled' | 'needs_setup' | 'attention' | 'unavailable';

const SELLER_CENTER_STATUSES: readonly SellerCenterStatus[] = [
    'ready',
    'disabled',
    'needs_setup',
    'attention',
    'unavailable',
];

export type SellerCenterIssue = { code: string; source: string };

const SELLER_CENTER_ISSUE_CODES = new Set([
    'SELLER_CONFIG_UNAVAILABLE',
    'IRS_CONFIG_UNAVAILABLE',
    'SELLER_MAPPING_SUMMARY_UNAVAILABLE',
    'SELLER_ORDER_SUMMARY_UNAVAILABLE',
    'IRS_ORDER_SUMMARY_UNAVAILABLE',
    'SELLER_ORDER_INDEXES_NOT_READY',
    'IRS_ORDER_STORAGE_UNAVAILABLE',
    'MALFORMED_SELLER_CENTER_RESPONSE',
]);

const SELLER_CENTER_ISSUE_SOURCES = new Set([
    'mongodb.settings.digiflazzSeller',
    'mongodb.settings.irsSeller',
    'mongodb.digiflazzSellerMappings',
    'mongodb.digiflazzSellerOrders',
    'mongodb.irsSellerOrders',
    'mongodb.indexes',
    'client.parser',
]);

export type SellerCenterOrderCounts = { total: number; pending: number; failed: number };

export type SellerCenterSummary = {
    ok: boolean;
    partial: boolean;
    issues: SellerCenterIssue[];
    generatedAt: string;
    digiflazz: {
        configured: boolean;
        ready: boolean;
        status: SellerCenterStatus;
        orders: SellerCenterOrderCounts & { callbackPending: number };
    };
    irs: {
        enabled: boolean;
        configured: boolean;
        ready: boolean;
        status: SellerCenterStatus;
        orders: SellerCenterOrderCounts;
    };
    mappings: { total: number; active: number };
};

const MALFORMED_SELLER_CENTER_ISSUE: SellerCenterIssue = {
    code: 'MALFORMED_SELLER_CENTER_RESPONSE',
    source: 'client.parser',
};

const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';

const isNonNegativeInt = (value: unknown): value is number =>
    Number.isSafeInteger(value) && (value as number) >= 0;

const isStatus = (value: unknown): value is SellerCenterStatus =>
    typeof value === 'string' && (SELLER_CENTER_STATUSES as readonly string[]).includes(value);

const parseIssue = (value: unknown): SellerCenterIssue | null => {
    if (!isRecord(value)) return null;
    const { code, source } = value;
    if (
        typeof code !== 'string' ||
        typeof source !== 'string' ||
        !SELLER_CENTER_ISSUE_CODES.has(code) ||
        !SELLER_CENTER_ISSUE_SOURCES.has(source) ||
        (code === 'MALFORMED_SELLER_CENTER_RESPONSE' && source !== 'client.parser')
    ) {
        return null;
    }
    return { code, source };
};

const parseCounts = (value: unknown, keys: readonly string[]): SellerCenterOrderCounts & { callbackPending?: number } | null => {
    if (!isRecord(value)) return null;
    const counts: Record<string, number> = {};
    for (const key of keys) {
        const entry = value[key];
        if (!isNonNegativeInt(entry)) return null;
        counts[key] = entry;
    }
    return counts as SellerCenterOrderCounts & { callbackPending?: number };
};

export const malformedSellerCenterSummary = (): SellerCenterSummary => ({
    ok: false,
    partial: true,
    issues: [MALFORMED_SELLER_CENTER_ISSUE],
    generatedAt: '',
    digiflazz: {
        configured: false,
        ready: false,
        status: 'unavailable',
        orders: { total: 0, pending: 0, failed: 0, callbackPending: 0 },
    },
    irs: {
        enabled: false,
        configured: false,
        ready: false,
        status: 'unavailable',
        orders: { total: 0, pending: 0, failed: 0 },
    },
    mappings: { total: 0, active: 0 },
});

export const parseSellerCenterSummary = (value: unknown): SellerCenterSummary => {
    if (!isRecord(value)) return malformedSellerCenterSummary();
    const { ok, partial, issues, generatedAt, digiflazz, irs, mappings } = value;
    if (!isBoolean(ok) || !isBoolean(partial)) return malformedSellerCenterSummary();
    if (typeof generatedAt !== 'string' || !RFC3339_PATTERN.test(generatedAt)) {
        return malformedSellerCenterSummary();
    }
    if (!Array.isArray(issues)) return malformedSellerCenterSummary();
    const parsedIssues: SellerCenterIssue[] = [];
    for (const issue of issues) {
        const parsed = parseIssue(issue);
        if (!parsed) return malformedSellerCenterSummary();
        parsedIssues.push(parsed);
    }
    if (!isRecord(digiflazz) || !isRecord(irs) || !isRecord(mappings)) {
        return malformedSellerCenterSummary();
    }
    if (
        !isBoolean(digiflazz.configured) ||
        !isBoolean(digiflazz.ready) ||
        !isStatus(digiflazz.status)
    ) {
        return malformedSellerCenterSummary();
    }
    const digiflazzOrders = parseCounts(digiflazz.orders, ['total', 'pending', 'failed', 'callbackPending']);
    if (!digiflazzOrders) return malformedSellerCenterSummary();
    if (
        !isBoolean(irs.enabled) ||
        !isBoolean(irs.configured) ||
        !isBoolean(irs.ready) ||
        !isStatus(irs.status)
    ) {
        return malformedSellerCenterSummary();
    }
    const irsOrders = parseCounts(irs.orders, ['total', 'pending', 'failed']);
    if (!irsOrders) return malformedSellerCenterSummary();
    if (!isNonNegativeInt(mappings.total) || !isNonNegativeInt(mappings.active)) {
        return malformedSellerCenterSummary();
    }
    return {
        ok,
        partial,
        issues: parsedIssues,
        generatedAt,
        digiflazz: {
            configured: digiflazz.configured,
            ready: digiflazz.ready,
            status: digiflazz.status,
            orders: {
                total: digiflazzOrders.total,
                pending: digiflazzOrders.pending,
                failed: digiflazzOrders.failed,
                callbackPending: digiflazzOrders.callbackPending ?? 0,
            },
        },
        irs: {
            enabled: irs.enabled,
            configured: irs.configured,
            ready: irs.ready,
            status: irs.status,
            orders: {
                total: irsOrders.total,
                pending: irsOrders.pending,
                failed: irsOrders.failed,
            },
        },
        mappings: { total: mappings.total, active: mappings.active },
    };
};
