import { useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw, Save } from 'lucide-react';
import { apiV2 } from '../../api';
import { useStepUpOrchestration } from '../../auth/useStepUpOrchestration';
import { stepUpActionErrorMessage } from '../../auth/withStepUp';

type IrsSettings = {
    enabled?: boolean;
    merchantId?: string;
    password?: string;
    pin?: string;
    secret?: string;
    endpointUrl?: string;
    allowedIps?: string[];
    sellerMarginFlat?: number;
    callbackEnabled?: boolean;
    callbackUrl?: string;
    configured?: boolean;
    ready?: boolean;
    formatter?: any;
};

type OrderItem = {
    _id?: string;
    id?: string;
    refId?: string;
    irsCode?: string;
    productCode?: string;
    target?: string;
    status?: string;
    statusCode?: string;
    message?: string;
    sn?: string;
    createdAt?: string;
};

const DEFAULT_ENDPOINT = 'https://v1.apigames.id/v2/transaksi-irs';

export default function IrsSellerSettings() {
    const stepUp = useStepUpOrchestration();
    const [activeTab, setActiveTab] = useState<'settings' | 'orders'>('settings');
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    const [formatterText, setFormatterText] = useState('');
    const [formatterError, setFormatterError] = useState('');
    const [settings, setSettings] = useState<IrsSettings>({ endpointUrl: DEFAULT_ENDPOINT });
    const [mappingCount, setMappingCount] = useState(0);
    const [orders, setOrders] = useState<OrderItem[]>([]);
    const [logs, setLogs] = useState<any[]>([]);

    const allowedIpsText = useMemo(() => (settings.allowedIps || []).join('\n'), [settings.allowedIps]);

    const loadAll = async () => {
        try {
            setLoading(true);
            const [settingsRes, mappingsRes, ordersRes, logsRes] = await Promise.all([
                apiV2.get('/irs-seller/settings'),
                apiV2.get('/irs-seller/mappings'),
                apiV2.get('/irs-seller/orders/admin'),
                apiV2.get('/irs-seller/logs')
            ]);
            const nextSettings = { endpointUrl: DEFAULT_ENDPOINT, ...settingsRes.data };
            setSettings(nextSettings);
            setFormatterText(nextSettings.formatter ? JSON.stringify(nextSettings.formatter, null, 2) : '');
            setFormatterError('');
            setMappingCount(Array.isArray(mappingsRes.data?.items) ? mappingsRes.data.items.length : 0);
            setOrders(Array.isArray(ordersRes.data?.items) ? ordersRes.data.items : []);
            setLogs(Array.isArray(logsRes.data) ? logsRes.data : (logsRes.data?.items || []));
        } catch (error: any) {
            setMessage(error.response?.data?.message || 'Gagal memuat konfigurasi IRS Seller.');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        void loadAll();
    }, []);

    const saveSettings = async () => {
        try {
            setSaving(true);
            setMessage(null);
            let formatter = settings.formatter;
            if (formatterText.trim()) {
                try {
                    formatter = JSON.parse(formatterText);
                    setFormatterError('');
                } catch {
                    setFormatterError('Format JSON formatter tidak valid.');
                    setSaving(false);
                    return;
                }
            } else {
                formatter = undefined;
            }
            await stepUp.run('integrations.credentials', (config) =>
                apiV2.post('/irs-seller/settings', {
                    ...settings,
                    formatter,
                    allowedIps: allowedIpsText.split('\n').map((item) => item.trim()).filter(Boolean),
                    endpointUrl: settings.endpointUrl || DEFAULT_ENDPOINT
                }, config as never),
            );
            setMessage('Konfigurasi IRS Seller berhasil disimpan.');
            await loadAll();
        } catch (error: any) {
            const text = stepUpActionErrorMessage(error, 'Gagal menyimpan konfigurasi IRS Seller.');
            if (text) setMessage(text);
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return (
            <div className="flex min-h-[40vh] items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin ui-accent-text" />
            </div>
        );
    }

    return (<>

        <div className="space-y-5">
            {message ? <div className="rounded-2xl border ui-info-chip px-4 py-3 text-sm">{message}</div> : null}

            <div className="grid gap-4 md:grid-cols-3">
                <div className={`rounded-2xl border p-4 ${settings.configured ? 'ui-success-chip' : 'ui-warning-chip'}`}>
                    <p className="text-xs font-bold uppercase tracking-[0.18em]">Status IRS</p>
                    <p className="mt-2 text-lg font-black">{settings.configured ? 'Configured' : 'Belum lengkap'}</p>
                </div>
                <div className={`rounded-2xl border p-4 ${settings.ready ? 'ui-success-chip' : 'ui-info-chip'}`}>
                    <p className="text-xs font-bold uppercase tracking-[0.18em]">Mapping Bersama</p>
                    <p className="mt-2 text-lg font-black">{mappingCount} mapping Digiflazz</p>
                </div>
                <div className="rounded-2xl border ui-panel-muted p-4">
                    <p className="text-xs font-bold uppercase tracking-[0.18em] ui-text-muted">Endpoint</p>
                    <p className="mt-2 break-all text-sm font-semibold ui-text">/api/v2/irs-seller/prepaid</p>
                </div>
            </div>

            <div className="rounded-2xl border ui-border ui-panel-muted p-4 text-sm ui-text-muted">
                IRS memakai <span className="font-semibold ui-text">mapping produk Digiflazz Seller yang sama</span>.
                Kelola kode produk, harga, dan status jual di tab <span className="font-semibold ui-text">API → Mapping Produk</span>.
                Field IRS <code>produk</code>/<code>kode_produk</code> akan dicocokkan ke <code>digiflazzsellerproductmaps.pulsaCode</code>.
            </div>

            <div className="flex flex-wrap gap-2">
                {(['settings', 'orders'] as const).map((tab) => (
                    <button
                        key={tab}
                        onClick={() => setActiveTab(tab)}
                        className={`rounded-xl border px-4 py-2 text-sm font-semibold ${activeTab === tab ? 'ui-accent-chip' : 'ui-muted-action'}`}
                    >
                        {tab === 'settings' ? 'Settings IRS' : 'Orders & Logs IRS'}
                    </button>
                ))}
                <button onClick={() => void loadAll()} className="ui-muted-action inline-flex items-center gap-2 rounded-xl border px-4 py-2 text-sm font-semibold">
                    <RefreshCw className="h-4 w-4" /> Refresh
                </button>
            </div>

            {activeTab === 'settings' ? (
                <div className="ui-panel rounded-3xl border p-5">
                    <div className="grid gap-4 md:grid-cols-2">
                        <Toggle label="Aktifkan IRS Seller" checked={settings.enabled === true} onChange={(enabled) => setSettings((current) => ({ ...current, enabled }))} />
                        <Field label="Endpoint IRS" value={settings.endpointUrl || DEFAULT_ENDPOINT} onChange={(endpointUrl) => setSettings((current) => ({ ...current, endpointUrl }))} />
                        <Field label="Merchant ID" value={settings.merchantId || ''} onChange={(merchantId) => setSettings((current) => ({ ...current, merchantId }))} />
                        <Field label="Password / Pass" value={settings.password || ''} onChange={(password) => setSettings((current) => ({ ...current, password }))} type="password" />
                        <Field label="PIN" value={settings.pin || ''} onChange={(pin) => setSettings((current) => ({ ...current, pin }))} type="password" />
                        <Field label="Secret" value={settings.secret || ''} onChange={(secret) => setSettings((current) => ({ ...current, secret }))} type="password" />
                        <label className="md:col-span-2">
                            <span className="mb-2 block text-sm font-semibold ui-text">Allowed IPs IRS</span>
                            <textarea
                                className="ui-field min-h-28 w-full rounded-xl border px-3 py-2 text-sm outline-none"
                                value={allowedIpsText}
                                onChange={(event) => setSettings((current) => ({ ...current, allowedIps: event.target.value.split('\n') }))}
                                placeholder="Satu IP per baris. Kosongkan untuk tidak whitelist."
                            />
                        </label>

                        <label className="md:col-span-2">
                            <span className="mb-2 block text-sm font-semibold ui-text">Formatter (JSON)</span>
                            <textarea
                                className="ui-field min-h-40 w-full rounded-xl border px-3 py-2 text-sm font-mono outline-none"
                                value={formatterText}
                                onChange={(event) => {
                                    setFormatterText(event.target.value);
                                    try {
                                        const parsed = JSON.parse(event.target.value || '{}');
                                        setSettings((current) => ({ ...current, formatter: parsed }));
                                        setFormatterError('');
                                    } catch {
                                        setFormatterError('Format JSON formatter tidak valid.');
                                    }
                                }}
                                placeholder='{"sn":{"start":"SN:","end":"Sisa Saldo"}, ...}'
                            />
                            <p className="mt-1 text-xs ui-text-muted">Gunakan format seperti sample IRS (keyword, start/end untuk sn, harga, sisaSaldo, dll).</p>
                            {formatterError ? <p className="mt-1 text-xs font-semibold text-red-500">{formatterError}</p> : null}
                        </label>
                    </div>
                    <button onClick={saveSettings} disabled={saving || Boolean(formatterError)} className="ui-accent-solid mt-5 inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold disabled:opacity-60">
                        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                        Simpan Settings IRS
                    </button>
                </div>
            ) : null}

            {activeTab === 'orders' ? (
                <div className="grid gap-4 xl:grid-cols-2">
                    <DataTable title="Order IRS Terbaru" rows={orders} columns={['refId', 'irsCode', 'target', 'status', 'statusCode', 'message', 'sn']} />
                    <DataTable title="Log IRS" rows={logs} columns={['refId', 'status', 'message', 'verified', 'requestIp']} />
                </div>
            ) : null}
        </div>
            {stepUp.dialog}
        </>
    );
}

function Field({ label, value, onChange, type = 'text' }: { label: string; value: string; onChange: (value: string) => void; type?: string }) {
    return (
        <label>
            <span className="mb-2 block text-sm font-semibold ui-text">{label}</span>
            <input className="ui-field w-full rounded-xl border px-3 py-2 text-sm outline-none" type={type} value={value} onChange={(event) => onChange(event.target.value)} />
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

function DataTable({ title, rows, columns }: { title: string; rows: any[]; columns: string[] }) {
    return (
        <div className="ui-panel overflow-hidden rounded-3xl border">
            <div className="border-b ui-border px-5 py-4">
                <h2 className="text-lg font-black ui-text">{title}</h2>
                <p className="text-sm ui-text-muted">{rows.length} data</p>
            </div>
            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                    <thead className="bg-[var(--ui-card-muted)]">
                        <tr>{columns.map((column) => <th key={column} className="px-4 py-3 text-left text-xs font-bold uppercase ui-text-muted">{column}</th>)}</tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--ui-border)]">
                        {rows.length === 0 ? (
                            <tr><td colSpan={columns.length} className="px-4 py-10 text-center ui-text-muted">Belum ada data</td></tr>
                        ) : rows.map((row, index) => (
                            <tr key={row._id || row.id || index}>{columns.map((column) => <td key={column} className="max-w-[220px] truncate px-4 py-3 ui-text" title={String(row[column] ?? '')}>{String(row[column] ?? '-')}</td>)}</tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
