import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Loader2, Package, Save } from 'lucide-react';
import axios from 'axios';

import { apiV2 } from '../../api';
import type { useStepUpOrchestration } from '../../auth/useStepUpOrchestration';
import { stepUpActionErrorMessage } from '../../auth/withStepUp';
import type { SellerCenterChildProps } from './DigiflazzSellerCenter';

type StepUp = ReturnType<typeof useStepUpOrchestration>;

type IrsSettingsState = {
    configured: boolean;
    ready: boolean;
    enabled: boolean;
    merchantId: string;
    passwordConfigured: boolean;
    pinConfigured: boolean;
    secretConfigured: boolean;
    endpointUrl: string;
    allowedIpsText: string;
    sellerMarginFlat: number;
    callbackEnabled: boolean;
    callbackUrl: string;
    prepaidEndpointPath: string;
    mappingActive: number;
    // Write-only editing fields; never hydrated from the server.
    password: string;
    pin: string;
    secret: string;
    formatterStart: string;
    formatterEnd: string;
};

type IrsAdminOrderItem = {
    id: string;
    refId: string;
    internalRefId: string;
    irsCode: string;
    target: string;
    status: string;
    statusCode: string;
    message: string;
    sn: string;
    vendorTrxId: string;
    requestIp: string;
    createdAt: string;
    updatedAt: string;
};

type IrsLogItem = {
    id: string;
    timestamp: string;
    event: string;
    refId: string;
    status: string;
    message: string;
    verified: boolean;
    requestIp: string;
};

type ResourceState = 'loading' | 'ready' | 'empty' | 'denied' | 'unavailable';

const DEFAULT_ENDPOINT = 'https://v1.apigames.id/v2/transaksi-irs';
const FORMATTER_MARKER_MAX = 80;

const defaultSettingsState: IrsSettingsState = {
    configured: false,
    ready: false,
    enabled: false,
    merchantId: '',
    passwordConfigured: false,
    pinConfigured: false,
    secretConfigured: false,
    endpointUrl: DEFAULT_ENDPOINT,
    allowedIpsText: '',
    sellerMarginFlat: 0,
    callbackEnabled: false,
    callbackUrl: '',
    prepaidEndpointPath: '/v2/irs-seller/prepaid',
    mappingActive: 0,
    password: '',
    pin: '',
    secret: '',
    formatterStart: '',
    formatterEnd: '',
};

const isPlainObjectArray = (value: unknown): value is Record<string, unknown>[] =>
    Array.isArray(value);

const mapOrderItem = (value: Record<string, unknown>): IrsAdminOrderItem => ({
    id: String(value.id || ''),
    refId: String(value.refId || ''),
    internalRefId: String(value.internalRefId || ''),
    irsCode: String(value.irsCode || ''),
    target: String(value.target || ''),
    status: String(value.status || ''),
    statusCode: String(value.statusCode || ''),
    message: String(value.message || ''),
    sn: String(value.sn || ''),
    vendorTrxId: String(value.vendorTrxId || ''),
    requestIp: String(value.requestIp || ''),
    createdAt: String(value.createdAt || ''),
    updatedAt: String(value.updatedAt || ''),
});

const mapLogItem = (value: Record<string, unknown>): IrsLogItem => ({
    id: String(value.id || ''),
    timestamp: String(value.timestamp || ''),
    event: String(value.event || ''),
    refId: String(value.refId || ''),
    status: String(value.status || ''),
    message: String(value.message || ''),
    verified: Boolean(value.verified),
    requestIp: String(value.requestIp || ''),
});

const resolveResourceState = (error: unknown): ResourceState => {
    if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 401 || status === 403) return 'denied';
    }
    return 'unavailable';
};

const formatDateTime = (value?: string) => {
    if (!value) return '-';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString('id-ID');
};

type IntegrationProps = SellerCenterChildProps & { stepUp: StepUp };

export default function IrsSellerIntegration({
    refreshRevision,
    onMutationComplete,
    onNavigateSection,
    stepUp,
}: IntegrationProps) {
    const [settings, setSettings] = useState<IrsSettingsState>(defaultSettingsState);
    const [settingsLoading, setSettingsLoading] = useState(true);
    const [settingsLoaded, setSettingsLoaded] = useState(false);
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
    const [formatterError, setFormatterError] = useState('');

    const [orders, setOrders] = useState<IrsAdminOrderItem[]>([]);
    const [ordersState, setOrdersState] = useState<ResourceState>('loading');
    const [logs, setLogs] = useState<IrsLogItem[]>([]);
    const [logsState, setLogsState] = useState<ResourceState>('loading');

    const fetchSettings = useCallback(async () => {
        try {
            setSettingsLoading(true);
            const response = await apiV2.get('/irs-seller/settings');
            const data = response.data || {};
            setSettings((current) => ({
                ...current,
                configured: Boolean(data.configured),
                ready: Boolean(data.ready),
                enabled: Boolean(data.enabled),
                merchantId: data.merchantId || '',
                passwordConfigured: Boolean(data.passwordConfigured),
                pinConfigured: Boolean(data.pinConfigured),
                secretConfigured: Boolean(data.secretConfigured),
                endpointUrl: data.endpointUrl || DEFAULT_ENDPOINT,
                allowedIpsText: Array.isArray(data.allowedIps) ? data.allowedIps.join('\n') : '',
                sellerMarginFlat: Number(data.sellerMarginFlat || 0),
                callbackEnabled: Boolean(data.callbackEnabled),
                callbackUrl: data.callbackUrl || '',
                prepaidEndpointPath: data.prepaidEndpointPath || '/v2/irs-seller/prepaid',
                mappingActive: Number(data.mappingSummary?.active || 0),
                formatterStart: String(data.formatter?.sn?.start || ''),
                formatterEnd: String(data.formatter?.sn?.end || ''),
                // Secrets stay write-only: reloads never hydrate editing fields.
                password: '',
                pin: '',
                secret: '',
            }));
            setSettingsLoaded(true);
        } catch (error) {
            console.error('Failed to fetch IRS settings:', error);
            setSettingsLoaded(false);
            setMessage({ type: 'error', text: 'Gagal memuat konfigurasi IRS.' });
        } finally {
            setSettingsLoading(false);
        }
    }, []);

    const fetchOrders = useCallback(async () => {
        try {
            setOrdersState('loading');
            const response = await apiV2.get('/irs-seller/orders/admin');
            const items = isPlainObjectArray(response.data?.items) ? response.data.items.map(mapOrderItem) : [];
            setOrders(items);
            setOrdersState(items.length === 0 ? 'empty' : 'ready');
        } catch (error) {
            setOrdersState(resolveResourceState(error));
        }
    }, []);

    const fetchLogs = useCallback(async () => {
        try {
            setLogsState('loading');
            const response = await apiV2.get('/irs-seller/logs');
            const items = isPlainObjectArray(response.data) ? response.data.map(mapLogItem) : [];
            setLogs(items);
            setLogsState(items.length === 0 ? 'empty' : 'ready');
        } catch (error) {
            setLogsState(resolveResourceState(error));
        }
    }, []);

    useEffect(() => {
        void fetchSettings();
        void fetchOrders();
        void fetchLogs();
    }, [refreshRevision, fetchSettings, fetchOrders, fetchLogs]);

    useEffect(() => {
        if (!message) return;
        const timer = window.setTimeout(() => setMessage(null), 4500);
        return () => window.clearTimeout(timer);
    }, [message]);

    const handleSave = async (event: React.FormEvent) => {
        event.preventDefault();
        if (!settingsLoaded) {
            setMessage({ type: 'error', text: 'Konfigurasi IRS belum dimuat. Simpan ditolak.' });
            return;
        }
        if (settings.formatterStart.length > FORMATTER_MARKER_MAX || settings.formatterEnd.length > FORMATTER_MARKER_MAX) {
            setFormatterError(`Marker formatter maksimal ${FORMATTER_MARKER_MAX} karakter.`);
            return;
        }
        setFormatterError('');
        try {
            setSaving(true);
            const payload: Record<string, unknown> = {
                enabled: settings.enabled,
                merchantId: settings.merchantId.trim(),
                endpointUrl: settings.endpointUrl.trim() || DEFAULT_ENDPOINT,
                allowedIps: settings.allowedIpsText.split(/\n|,/).map((item) => item.trim()).filter(Boolean),
                callbackEnabled: settings.callbackEnabled,
                callbackUrl: settings.callbackUrl.trim(),
                sellerMarginFlat: Number(settings.sellerMarginFlat || 0),
            };
            if (settingsLoaded) payload.formatter = { sn: { start: settings.formatterStart, end: settings.formatterEnd } };
            // Blank secrets preserve the stored values server-side.
            if (settings.password.trim()) payload.password = settings.password.trim();
            if (settings.pin.trim()) payload.pin = settings.pin.trim();
            if (settings.secret.trim()) payload.secret = settings.secret.trim();

            await stepUp.run('integrations.credentials', (config) =>
                apiV2.post('/irs-seller/settings', payload, config as never),
            );
            setMessage({ type: 'success', text: 'Konfigurasi IRS berhasil disimpan' });
            await fetchSettings();
            onMutationComplete();
        } catch (error) {
            const text = stepUpActionErrorMessage(error, 'Gagal menyimpan konfigurasi IRS.');
            if (text) setMessage({ type: 'error', text });
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="space-y-5" aria-busy={settingsLoading}>
            {message && (
                <div className={`rounded-xl border px-4 py-3 text-sm ${message.type === 'error' ? 'ui-danger-chip' : 'ui-success-chip'}`}>
                    {message.text}
                </div>
            )}

            <div className="grid gap-4 md:grid-cols-3">
                <div className={`rounded-2xl border p-4 ${settings.configured ? 'ui-success-chip' : 'ui-warning-chip'}`}>
                    <p className="text-xs font-bold uppercase tracking-[0.18em]">Status IRS</p>
                    <p className="mt-2 inline-flex items-center gap-2 text-lg font-black">
                        {settingsLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : settings.configured ? <CheckCircle2 className="h-5 w-5" /> : null}
                        {settings.enabled ? (settings.configured ? 'Aktif & lengkap' : 'Aktif, kredensial belum lengkap') : 'Nonaktif'}
                    </p>
                </div>
                <div className="rounded-2xl border ui-info-chip p-4">
                    <p className="text-xs font-bold uppercase tracking-[0.18em]">Mapping Bersama</p>
                    <p className="mt-2 text-lg font-black">{settings.mappingActive} mapping aktif</p>
                    <button
                        type="button"
                        onClick={() => onNavigateSection('mappings')}
                        className="mt-2 inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-semibold ui-muted-action hover:border-[var(--ui-accent)]"
                    >
                        <Package className="h-3.5 w-3.5" /> Kelola Mapping Produk
                    </button>
                </div>
                <div className="rounded-2xl border ui-panel-muted p-4">
                    <p className="text-xs font-bold uppercase tracking-[0.18em] ui-text-muted">Endpoint Publik</p>
                    <p className="mt-2 break-all text-sm font-semibold ui-text">/api{settings.prepaidEndpointPath}</p>
                </div>
            </div>

            <div className="rounded-2xl border ui-border ui-panel-muted p-4 text-sm ui-text-muted">
                IRS adalah integrasi internal Digiflazz Seller Center dan memakai mapping produk yang sama.
                Field IRS <code>produk</code>/<code>kode_produk</code> dicocokkan ke <code>digiflazzsellerproductmaps.pulsaCode</code>.
            </div>

            <form onSubmit={handleSave} className="space-y-4 rounded-2xl border ui-border ui-panel-muted p-5">
                <div className="flex items-center justify-between">
                    <h2 className="text-lg font-bold ui-text">Konfigurasi Integrasi IRS</h2>
                    {settingsLoading && <Loader2 className="h-4 w-4 animate-spin ui-warning-text" />}
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                    <Toggle
                        label="Aktifkan IRS Seller"
                        checked={settings.enabled}
                        onChange={(enabled) => setSettings((current) => ({ ...current, enabled }))}
                    />
                    <Field
                        label="Endpoint IRS"
                        value={settings.endpointUrl}
                        onChange={(endpointUrl) => setSettings((current) => ({ ...current, endpointUrl }))}
                    />
                    <Field
                        label="Merchant ID"
                        value={settings.merchantId}
                        onChange={(merchantId) => setSettings((current) => ({ ...current, merchantId }))}
                    />
                    <SecretField
                        label="Password / Pass"
                        value={settings.password}
                        configured={settings.passwordConfigured}
                        onChange={(password) => setSettings((current) => ({ ...current, password }))}
                    />
                    <SecretField
                        label="PIN"
                        value={settings.pin}
                        configured={settings.pinConfigured}
                        onChange={(pin) => setSettings((current) => ({ ...current, pin }))}
                    />
                    <SecretField
                        label="Secret"
                        value={settings.secret}
                        configured={settings.secretConfigured}
                        onChange={(secret) => setSettings((current) => ({ ...current, secret }))}
                    />
                    <Field
                        label="Margin Seller Nominal"
                        value={String(settings.sellerMarginFlat)}
                        type="number"
                        onChange={(value) => setSettings((current) => ({ ...current, sellerMarginFlat: Number(value || 0) }))}
                    />
                    <label className="md:col-span-2">
                        <span className="mb-2 block text-sm font-semibold ui-text">Allowed IPs IRS</span>
                        <textarea
                            className="ui-field min-h-28 w-full rounded-xl border px-3 py-2 text-sm outline-none"
                            value={settings.allowedIpsText}
                            onChange={(event) => setSettings((current) => ({ ...current, allowedIpsText: event.target.value }))}
                            placeholder="Satu IP per baris. Kosongkan untuk tidak whitelist."
                        />
                    </label>

                    <div className="md:col-span-2">
                        <span className="mb-2 block text-sm font-semibold ui-text">Formatter SN (literal, maks. {FORMATTER_MARKER_MAX} karakter)</span>
                        <div className="grid gap-4 md:grid-cols-2">
                            <Field
                                label="SN Start"
                                value={settings.formatterStart}
                                maxLength={FORMATTER_MARKER_MAX}
                                onChange={(formatterStart) => setSettings((current) => ({ ...current, formatterStart }))}
                            />
                            <Field
                                label="SN End"
                                value={settings.formatterEnd}
                                maxLength={FORMATTER_MARKER_MAX}
                                onChange={(formatterEnd) => setSettings((current) => ({ ...current, formatterEnd }))}
                            />
                        </div>
                        <p className="mt-1 text-xs ui-text-muted">Hanya dua marker literal SN yang disimpan; struktur teks bebas dan alias kredensial tidak diterima.</p>
                        {formatterError ? <p className="mt-1 text-xs font-semibold text-red-500">{formatterError}</p> : null}
                    </div>

                    <Toggle
                        label="Callback IRS aktif"
                        checked={settings.callbackEnabled}
                        onChange={(callbackEnabled) => setSettings((current) => ({ ...current, callbackEnabled }))}
                    />
                    <Field
                        label="Callback URL IRS"
                        value={settings.callbackUrl}
                        onChange={(callbackUrl) => setSettings((current) => ({ ...current, callbackUrl }))}
                    />
                </div>

                <div className="flex justify-end">
                    <button
                        type="submit"
                        disabled={saving || settingsLoading || !settingsLoaded}
                        className="inline-flex items-center gap-2 rounded-xl ui-accent-solid px-4 py-2.5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                        {saving ? 'Menyimpan...' : 'Simpan Konfigurasi IRS'}
                    </button>
                </div>
            </form>

            <div className="grid gap-4 xl:grid-cols-2">
                <DataTable
                    title="Order IRS Terbaru"
                    state={ordersState}
                    emptyText="Belum ada order IRS."
                    deniedText="Anda memerlukan izin viewTransactions untuk melihat order IRS."
                    unavailableText="Penyimpanan order IRS tidak tersedia."
                    columns={['Ref ID', 'Produk', 'Target', 'Status', 'Pesan']}
                    desktopRows={orders.map((order) => [
                        order.refId,
                        order.irsCode,
                        order.target,
                        `${order.status} (${order.statusCode})`,
                        order.sn ? `${order.message} • SN ${order.sn}` : order.message,
                    ])}
                    mobileCards={orders.map((order) => ({
                        key: order.id,
                        title: order.refId,
                        badge: order.status,
                        lines: [
                            `Produk ${order.irsCode} • ${order.target}`,
                            order.message,
                            order.sn ? `SN ${order.sn}` : '',
                            formatDateTime(order.createdAt),
                        ],
                    }))}
                />
                <DataTable
                    title="Log IRS"
                    state={logsState}
                    emptyText="Belum ada log IRS."
                    deniedText="Anda memerlukan izin akses untuk melihat log IRS."
                    unavailableText="Penyimpanan log IRS tidak tersedia."
                    columns={['Waktu', 'Event', 'Status', 'Pesan']}
                    desktopRows={logs.map((log) => [
                        formatDateTime(log.timestamp),
                        log.event,
                        log.verified ? `${log.status} ✓` : log.status,
                        log.message,
                    ])}
                    mobileCards={logs.map((log) => ({
                        key: log.id,
                        title: log.event,
                        badge: log.status,
                        lines: [log.refId, log.message, formatDateTime(log.timestamp)],
                    }))}
                />
            </div>
        </div>
    );
}

function Field({
    label,
    value,
    onChange,
    type = 'text',
    maxLength,
}: {
    label: string;
    value: string;
    onChange: (value: string) => void;
    type?: string;
    maxLength?: number;
}) {
    return (
        <label>
            <span className="mb-2 block text-sm font-semibold ui-text">{label}</span>
            <input
                className="ui-field w-full rounded-xl border px-3 py-2 text-sm outline-none"
                type={type}
                value={value}
                maxLength={maxLength}
                onChange={(event) => onChange(event.target.value)}
            />
        </label>
    );
}

function SecretField({
    label,
    value,
    configured,
    onChange,
}: {
    label: string;
    value: string;
    configured: boolean;
    onChange: (value: string) => void;
}) {
    return (
        <label>
            <span className="mb-2 block text-sm font-semibold ui-text">{label}</span>
            <input
                className="ui-field w-full rounded-xl border px-3 py-2 text-sm outline-none"
                type="password"
                autoComplete="new-password"
                value={value}
                placeholder={configured ? 'Tersimpan — isi untuk mengganti' : 'Belum diisi'}
                onChange={(event) => onChange(event.target.value)}
            />
            <span className="mt-1 block text-xs ui-text-muted">
                {configured ? 'Sudah tersimpan; kosongkan untuk mempertahankan.' : 'Kosongkan untuk tidak menyimpan.'}
            </span>
        </label>
    );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
    return (
        <label className="flex items-center justify-between gap-3 rounded-xl border ui-border bg-[var(--ui-card-muted)] px-4 py-3">
            <span className="text-sm font-semibold ui-text">{label}</span>
            <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
        </label>
    );
}

function DataTable({
    title,
    state,
    columns,
    desktopRows,
    mobileCards,
    emptyText,
    deniedText,
    unavailableText,
}: {
    title: string;
    state: ResourceState;
    columns: string[];
    desktopRows: string[][];
    mobileCards: { key: string; title: string; badge: string; lines: string[] }[];
    emptyText: string;
    deniedText: string;
    unavailableText: string;
}) {
    return (
        <div className="ui-panel overflow-hidden rounded-3xl border">
            <div className="border-b ui-border px-5 py-4">
                <h2 className="text-lg font-black ui-text">{title}</h2>
                <p className="text-sm ui-text-muted">{desktopRows.length} data</p>
            </div>
            {state === 'loading' ? (
                <div className="px-5 py-10 text-center ui-text-muted"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></div>
            ) : state === 'denied' ? (
                <div className="px-5 py-10 text-center text-sm ui-text-muted" role="status">{deniedText}</div>
            ) : state === 'unavailable' ? (
                <div className="px-5 py-10 text-center text-sm ui-danger-text" role="alert">{unavailableText}</div>
            ) : state === 'empty' ? (
                <div className="px-5 py-10 text-center text-sm ui-text-muted">{emptyText}</div>
            ) : (
                <>
                    <div className="hidden overflow-x-auto md:block">
                        <table className="w-full text-sm">
                            <thead className="bg-[var(--ui-card-muted)]">
                                <tr>{columns.map((column) => <th key={column} className="px-4 py-3 text-left text-xs font-bold uppercase ui-text-muted">{column}</th>)}</tr>
                            </thead>
                            <tbody className="divide-y divide-[var(--ui-border)]">
                                {desktopRows.map((row, rowIndex) => (
                                    <tr key={rowIndex}>
                                        {row.map((cell, cellIndex) => <td key={cellIndex} className="max-w-[220px] truncate px-4 py-3 ui-text" title={cell}>{cell || '-'}</td>)}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <div className="space-y-3 p-4 md:hidden">
                        {mobileCards.map((card) => (
                            <div key={card.key} className="rounded-xl border ui-border ui-panel-muted p-4">
                                <div className="flex items-center justify-between gap-2">
                                    <span className="truncate font-mono text-sm ui-text">{card.title}</span>
                                    <span className="inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ui-info-chip">{card.badge}</span>
                                </div>
                                {card.lines.filter(Boolean).map((line, index) => (
                                    <p key={index} className="mt-1 text-xs ui-text-muted">{line}</p>
                                ))}
                            </div>
                        ))}
                    </div>
                </>
            )}
        </div>
    );
}
