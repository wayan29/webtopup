/**
 * Pure vendor-health presentation contracts for `/admin/vendor-health`.
 *
 * This module contains no React, DOM, Axios, or store dependencies so it can be
 * verified with the Node test runner. Every parser is fail-closed: malformed
 * payloads degrade to an explicit unhealthy model instead of inventing success.
 */

export type VendorHealthState = 'healthy' | 'warning' | 'critical' | 'disabled' | 'unknown';
export type VendorHealthFreshnessState = 'fresh' | 'stale' | 'unknown';

const FRESH_MAX_AGE_SECONDS = 120;

const ISSUE_CODES = [
    'VENDOR_COLLECTION_UNAVAILABLE',
    'TRANSACTION_STATS_UNAVAILABLE',
    'WEBHOOK_STATS_UNAVAILABLE',
    'LAST_WEBHOOK_UNAVAILABLE',
    'SELLER_SUMMARY_UNAVAILABLE',
    'DIGIFLAZZ_BALANCE_UNAVAILABLE',
    'TOKOVOUCHER_BALANCE_UNAVAILABLE',
    'SNAPSHOT_PERSISTENCE_FAILED',
    'MALFORMED_VENDOR_HEALTH_RESPONSE',
] as const;

const ISSUE_SOURCES = [
    'mongodb.vendors',
    'mongodb.transactions',
    'mongodb.webhooks',
    'mongodb.webhooks.last',
    'mongodb.seller',
    'provider.digiflazz',
    'provider.tokovoucher',
    'mongodb.settings',
    'client.parser',
] as const;

const HEALTH_STATES: readonly VendorHealthState[] = ['healthy', 'warning', 'critical', 'disabled'];

export interface VendorHealthIssue {
    code: string;
    source: string;
}

export interface VendorHealthTransactions {
    total: number;
    success: number;
    failed: number;
    pending: number;
    successRate: number;
    amountTotal: number;
}

export interface VendorHealthWebhook {
    total: number;
    rejected: number;
    failed: number;
    delivered: number;
    lastAt: string | null;
    lastStatus: string;
    lastMessage: string;
}

export interface VendorHealthItem {
    key: string;
    label: string;
    configured: boolean;
    active: boolean;
    balance: number | null;
    balanceOk: boolean;
    lowBalanceThreshold: number;
    lowBalance: boolean;
    balanceMessage: string;
    health: VendorHealthState;
    transactionsToday: VendorHealthTransactions;
    webhookToday: VendorHealthWebhook;
}

export interface VendorHealthSeller {
    total: number;
    pending: number;
    failed: number;
    callbackPending: number;
    callbackDelivered: number;
    health: VendorHealthState;
}

export interface VendorHealthResponse {
    ok: boolean;
    partial: boolean;
    issues: VendorHealthIssue[];
    snapshotPersisted: boolean;
    generatedAt: string | null;
    vendors: VendorHealthItem[];
    seller: VendorHealthSeller | null;
}

export interface VendorHealthSnapshotVendor {
    key: string;
    label: string;
    configured: boolean;
    active: boolean;
    lowBalanceThreshold: number;
    health: VendorHealthState;
    healthReason: string;
    transactionsToday: VendorHealthTransactions;
}

export interface VendorHealthDiagnostics {
    ok: boolean;
    partial: boolean;
    issues: VendorHealthIssue[];
    generatedAt: string | null;
    source: string;
    vendors: VendorHealthSnapshotVendor[];
    totals: {
        vendors: number;
        healthy: number;
        warning: number;
        critical: number;
        transactionsToday: number;
    };
}

const MALFORMED_ISSUE: VendorHealthIssue = {
    code: 'MALFORMED_VENDOR_HEALTH_RESPONSE',
    source: 'client.parser',
};

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function asFiniteNumber(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asTrimmedString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function asNullableString(value: unknown): string | null {
    const text = asTrimmedString(value);
    return text.length > 0 ? text : null;
}

function asBoolean(value: unknown): boolean {
    return value === true;
}

function asHealthState(value: unknown): VendorHealthState {
    const text = asTrimmedString(value);
    return (HEALTH_STATES as readonly string[]).includes(text)
        ? (text as VendorHealthState)
        : 'unknown';
}

function asBalance(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function asIssueList(value: unknown): VendorHealthIssue[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const seen = new Set<string>();
    const issues: VendorHealthIssue[] = [];
    for (const entry of value) {
        const record = asRecord(entry);
        if (!record) {
            continue;
        }
        const code = asTrimmedString(record.code);
        const source = asTrimmedString(record.source);
        if (
            !(ISSUE_CODES as readonly string[]).includes(code) ||
            !(ISSUE_SOURCES as readonly string[]).includes(source)
        ) {
            continue;
        }
        const identity = `${code}|${source}`;
        if (seen.has(identity)) {
            continue;
        }
        seen.add(identity);
        issues.push({ code, source });
    }
    return issues;
}

function asGeneratedAt(value: unknown): string | null {
    const text = asTrimmedString(value);
    if (text === '') {
        return null;
    }
    if (/^\d{10,}$/.test(text)) {
        const epochMs = Number(text) * 1000;
        const parsed = new Date(epochMs);
        return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
    }
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function asTransactions(value: unknown): VendorHealthTransactions {
    const record = asRecord(value);
    if (!record) {
        return { total: 0, success: 0, failed: 0, pending: 0, successRate: 0, amountTotal: 0 };
    }
    return {
        total: asFiniteNumber(record.total, 0),
        success: asFiniteNumber(record.success, 0),
        failed: asFiniteNumber(record.failed, 0),
        pending: asFiniteNumber(record.pending, 0),
        // Rust serializes these as camelCase inside snake_case snapshot containers.
        successRate: asFiniteNumber(record.successRate, 0),
        amountTotal: asFiniteNumber(record.amountTotal, 0),
    };
}

function asWebhook(value: unknown): VendorHealthWebhook {
    const record = asRecord(value);
    if (!record) {
        return { total: 0, rejected: 0, failed: 0, delivered: 0, lastAt: null, lastStatus: '', lastMessage: '' };
    }
    return {
        total: asFiniteNumber(record.total, 0),
        rejected: asFiniteNumber(record.rejected, 0),
        failed: asFiniteNumber(record.failed, 0),
        delivered: asFiniteNumber(record.delivered, 0),
        lastAt: asNullableString(record.lastAt),
        lastStatus: asTrimmedString(record.lastStatus),
        lastMessage: asTrimmedString(record.lastMessage),
    };
}

function degradedResponse(): VendorHealthResponse {
    return {
        ok: false,
        partial: true,
        issues: [{ ...MALFORMED_ISSUE }],
        snapshotPersisted: false,
        generatedAt: null,
        vendors: [],
        seller: null,
    };
}

function degradedDiagnostics(): VendorHealthDiagnostics {
    return {
        ok: false,
        partial: true,
        issues: [{ ...MALFORMED_ISSUE }],
        generatedAt: null,
        source: '',
        vendors: [],
        totals: { vendors: 0, healthy: 0, warning: 0, critical: 0, transactionsToday: 0 },
    };
}

export function parseVendorHealthResponse(input: unknown): VendorHealthResponse {
    const record = asRecord(input);
    if (!record || !Array.isArray(record.vendors)) {
        return degradedResponse();
    }
    const vendors: VendorHealthItem[] = [];
    for (const entry of record.vendors) {
        const vendor = asRecord(entry);
        if (!vendor || asTrimmedString(vendor.key) === '') {
            return degradedResponse();
        }
        vendors.push({
            key: asTrimmedString(vendor.key),
            label: asTrimmedString(vendor.label) || asTrimmedString(vendor.key),
            configured: asBoolean(vendor.configured),
            active: asBoolean(vendor.active),
            balance: asBalance(vendor.balance),
            balanceOk: asBoolean(vendor.balanceOk),
            lowBalanceThreshold: asFiniteNumber(vendor.lowBalanceThreshold, 0),
            lowBalance: asBoolean(vendor.lowBalance),
            balanceMessage: asTrimmedString(vendor.balanceMessage),
            health: asHealthState(vendor.health),
            transactionsToday: asTransactions(vendor.transactionsToday),
            webhookToday: asWebhook(vendor.webhookToday),
        });
    }
    const sellerRecord = asRecord(record.seller);
    return {
        ok: asBoolean(record.ok),
        partial: asBoolean(record.partial),
        issues: asIssueList(record.issues),
        snapshotPersisted: asBoolean(record.snapshotPersisted),
        generatedAt: asGeneratedAt(record.generatedAt),
        vendors,
        seller: sellerRecord
            ? {
                  total: asFiniteNumber(sellerRecord.total, 0),
                  pending: asFiniteNumber(sellerRecord.pending, 0),
                  failed: asFiniteNumber(sellerRecord.failed, 0),
                  callbackPending: asFiniteNumber(sellerRecord.callbackPending, 0),
                  callbackDelivered: asFiniteNumber(sellerRecord.callbackDelivered, 0),
                  health: asHealthState(sellerRecord.health),
              }
            : null,
    };
}

export function parseVendorHealthDiagnostics(input: unknown): VendorHealthDiagnostics {
    const record = asRecord(input);
    if (!record || !Array.isArray(record.vendors)) {
        return degradedDiagnostics();
    }
    const vendors: VendorHealthSnapshotVendor[] = [];
    for (const entry of record.vendors) {
        const vendor = asRecord(entry);
        if (!vendor || asTrimmedString(vendor.key) === '') {
            return degradedDiagnostics();
        }
        vendors.push({
            key: asTrimmedString(vendor.key),
            label: asTrimmedString(vendor.label) || asTrimmedString(vendor.key),
            configured: asBoolean(vendor.configured),
            active: asBoolean(vendor.active),
            lowBalanceThreshold: asFiniteNumber(
                vendor.lowBalanceThreshold ?? vendor.low_balance_threshold,
                0,
            ),
            health: asHealthState(vendor.health),
            healthReason: asTrimmedString(vendor.health_reason ?? vendor.healthReason),
            transactionsToday: asTransactions(vendor.transactions_today ?? vendor.transactionsToday),
        });
    }
    const totalsRecord = asRecord(record.totals);
    const totals = totalsRecord ?? {};
    return {
        ok: asBoolean(record.ok),
        partial: asBoolean(record.partial),
        issues: asIssueList(record.issues),
        generatedAt: asGeneratedAt(record.generated_at ?? record.generatedAt),
        source: asTrimmedString(record.source),
        vendors,
        totals: {
            vendors: asFiniteNumber(totals.vendors, vendors.length),
            healthy: asFiniteNumber(totals.healthy, 0),
            warning: asFiniteNumber(totals.warning, 0),
            critical: asFiniteNumber(totals.critical, 0),
            transactionsToday: asFiniteNumber(
                totals.transactions_today ?? totals.transactionsToday,
                0,
            ),
        },
    };
}

export interface VendorHealthMeta {
    label: string;
    tone: 'success' | 'warning' | 'danger' | 'neutral';
}

export function vendorHealthMeta(state: VendorHealthState): VendorHealthMeta {
    switch (state) {
        case 'healthy':
            return { label: 'Sehat', tone: 'success' };
        case 'warning':
            return { label: 'Perlu perhatian', tone: 'warning' };
        case 'critical':
            return { label: 'Kritis', tone: 'danger' };
        case 'disabled':
            return { label: 'Dinonaktifkan', tone: 'neutral' };
        default:
            return { label: 'Tidak diketahui', tone: 'neutral' };
    }
}

export interface VendorFreshness {
    state: VendorHealthFreshnessState;
    ageSeconds: number | null;
    relativeLabel: string;
    absoluteLabel: string;
}

function formatDurationIndonesian(totalSeconds: number): string {
    if (totalSeconds < 60) {
        return `${Math.max(1, Math.floor(totalSeconds))} detik`;
    }
    if (totalSeconds < 3600) {
        return `${Math.floor(totalSeconds / 60)} menit`;
    }
    return `${Math.floor(totalSeconds / 3600)} jam`;
}

export function vendorFreshness(generatedAt: string | null | undefined, nowMs?: number): VendorFreshness {
    const normalized = asGeneratedAt(generatedAt);
    if (!normalized) {
        return {
            state: 'unknown',
            ageSeconds: null,
            relativeLabel: 'Waktu pembaruan tidak diketahui',
            absoluteLabel: '',
        };
    }
    const generatedMs = Date.parse(normalized);
    const now = typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : Date.now();
    const ageMs = Math.max(0, now - generatedMs);
    const ageSeconds = Math.floor(ageMs / 1000);
    const absoluteLabel = new Intl.DateTimeFormat('id-ID', {
        dateStyle: 'medium',
        timeStyle: 'medium',
    }).format(new Date(generatedMs));
    if (ageMs <= FRESH_MAX_AGE_SECONDS * 1000) {
        return {
            state: 'fresh',
            ageSeconds,
            relativeLabel: `Diperbarui ${formatDurationIndonesian(ageSeconds)} lalu`,
            absoluteLabel,
        };
    }
    return {
        state: 'stale',
        ageSeconds,
        relativeLabel: `Kedaluwarsa (diperbarui ${formatDurationIndonesian(ageSeconds)} lalu)`,
        absoluteLabel,
    };
}

const rupiahFormatter = new Intl.NumberFormat('id-ID', {
    maximumFractionDigits: 0,
});

export function vendorBalanceLabel(balanceOk: boolean, balance: number | null): string {
    if (!balanceOk || balance === null || !Number.isFinite(balance)) {
        return 'Tidak tersedia';
    }
    return `Rp${rupiahFormatter.format(balance)}`;
}

export function vendorSuccessRateLabel(total: number, rate: number): string {
    if (!Number.isFinite(total) || total <= 0) {
        return 'Belum ada transaksi';
    }
    const clamped = Number.isFinite(rate) ? rate : 0;
    return `${clamped}%`;
}

export function vendorHealthErrorMessage(error: unknown, fallback: string): string {
    const record = asRecord(error);
    const response = asRecord(record?.response);
    const data = asRecord(response?.data);
    const nestedError = asRecord(data?.error);
    const message = asTrimmedString(nestedError?.message) || asTrimmedString(data?.message);
    return message !== '' ? message : fallback;
}
