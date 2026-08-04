import { useEffect, useMemo, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, Download, ExternalLink, RefreshCw, Server, ShieldAlert, Wallet, XCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { apiV2 } from '../../api';
import { useStepUpOrchestration } from '../../auth/useStepUpOrchestration';
import { stepUpActionErrorMessage } from '../../auth/withStepUp';

type HealthState = 'healthy' | 'warning' | 'critical';

interface VendorHealthItem {
    key: 'digiflazz' | 'tokovoucher';
    label: string;
    configured: boolean;
    active: boolean;
    balance: number;
    balanceOk: boolean;
    lowBalanceThreshold: number;
    lowBalance: boolean;
    balanceMessage: string;
    health: HealthState;
    transactionsToday: {
        total: number;
        success: number;
        failed: number;
        pending: number;
        successRate: number;
        amountTotal: number;
    };
    webhookToday: {
        total: number;
        rejected: number;
        failed: number;
        delivered: number;
        lastAt?: string | null;
        lastStatus?: string;
        lastMessage?: string;
    };
}

interface VendorHealthResponse {
    generatedAt: string;
    vendors: VendorHealthItem[];
    seller: {
        total: number;
        pending: number;
        failed: number;
        callbackPending: number;
        callbackDelivered: number;
        health: HealthState;
    };
}

interface VendorHealthSnapshotItem {
    key: string;
    label: string;
    configured: boolean;
    active: boolean;
    low_balance_threshold: number;
    health: HealthState;
    health_reason: string;
    transactions_today: {
        total: number;
        success: number;
        failed: number;
        pending: number;
        success_rate: number;
        amount_total: number;
    };
}

interface VendorHealthSnapshotResponse {
    ok: boolean;
    generated_at: string;
    source: string;
    vendors: VendorHealthSnapshotItem[];
    totals: {
        vendors: number;
        healthy: number;
        warning: number;
        critical: number;
        transactions_today: number;
    };
}

const formatCurrency = (value: number) => `Rp${Number(value || 0).toLocaleString('id-ID')}`;
const formatDateTime = (value?: string | null) => value
    ? new Date(value).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '-';

const healthMeta: Record<HealthState, { label: string; className: string; icon: typeof CheckCircle2 }> = {
    healthy: { label: 'Healthy', className: 'ui-success-chip', icon: CheckCircle2 },
    warning: { label: 'Warning', className: 'ui-warning-chip', icon: AlertTriangle },
    critical: { label: 'Critical', className: 'ui-danger-chip', icon: XCircle }
};

const FALLBACK_HEALTH_META = { label: 'Unknown', className: 'ui-panel-muted', icon: AlertTriangle };

const getHealthMeta = (state: HealthState | string | null | undefined) => {
    if (state && state in healthMeta) {
        return healthMeta[state as HealthState];
    }
    return FALLBACK_HEALTH_META;
};

export default function VendorHealth() {
    const stepUp = useStepUpOrchestration();
    const [data, setData] = useState<VendorHealthResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [snapshot, setSnapshot] = useState<VendorHealthSnapshotResponse | null>(null);
    const [snapshotLoading, setSnapshotLoading] = useState(false);
    const [snapshotError, setSnapshotError] = useState('');
    const [exporting, setExporting] = useState(false);
    const [error, setError] = useState('');

    const fetchSnapshot = async () => {
        setSnapshotLoading(true);
        setSnapshotError('');

        try {
            const response = await apiV2.get<VendorHealthSnapshotResponse>('/vendors/health-snapshot');
            setSnapshot(response.data);
        } catch (err: any) {
            setSnapshotError(err.response?.data?.message || 'Snapshot API v2 belum tersedia');
        } finally {
            setSnapshotLoading(false);
        }
    };

    const fetchHealth = async () => {
        setLoading(true);
        setError('');

        try {
            const response = await apiV2.get<VendorHealthResponse>('/vendors/health');
            setData(response.data);
        } catch (err: any) {
            setError(err.response?.data?.message || 'Gagal memuat vendor health');
        } finally {
            setLoading(false);
        }

        fetchSnapshot();
    };

    useEffect(() => {
        fetchHealth();
    }, []);

    const handleExport = async () => {
        setExporting(true);
        setError('');

        try {
            const response = await stepUp.run('exports.sensitive', (config) =>
                apiV2.get('/vendors/health/export', { responseType: 'blob', ...config } as never),
            );
            const disposition = response.headers['content-disposition'] || '';
            const filenameMatch = /filename="?([^";]+)"?/i.exec(disposition);
            const filename = filenameMatch?.[1] || `vendor-health-${new Date().toISOString().slice(0, 10)}.csv`;
            const url = URL.createObjectURL(new Blob([response.data], { type: 'text/csv;charset=utf-8;' }));
            const link = document.createElement('a');
            link.href = url;
            link.setAttribute('download', filename);
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
        } catch (err: any) {
            const text = stepUpActionErrorMessage(err, 'Gagal export vendor health');
            if (text) setError(text);
        } finally {
            setExporting(false);
        }
    };

    const totals = useMemo(() => {
        const vendors = data?.vendors || [];
        return vendors.reduce((acc, vendor) => ({
            transactions: acc.transactions + vendor.transactionsToday.total,
            failed: acc.failed + vendor.transactionsToday.failed,
            pending: acc.pending + vendor.transactionsToday.pending,
            lowBalance: acc.lowBalance + (vendor.lowBalance ? 1 : 0),
            webhookRejected: acc.webhookRejected + vendor.webhookToday.rejected
        }), { transactions: 0, failed: 0, pending: 0, lowBalance: 0, webhookRejected: 0 });
    }, [data]);

    return (<>
        <div className="space-y-6">
            <section className="ui-panel-muted flex flex-wrap gap-2 rounded-2xl border ui-border p-4">
                <button
                    onClick={fetchHealth}
                    disabled={loading || snapshotLoading}
                    className="ui-muted-action inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold disabled:opacity-60"
                >
                    <RefreshCw className={`h-4 w-4 ${loading || snapshotLoading ? 'animate-spin' : ''}`} /> Refresh
                </button>
                <button
                    onClick={handleExport}
                    disabled={exporting}
                    className="ui-accent-solid inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold disabled:opacity-60"
                >
                    <Download className={`h-4 w-4 ${exporting ? 'animate-pulse' : ''}`} /> Export CSV
                </button>
            </section>

            <section className="ui-panel rounded-[24px] border ui-border p-5">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="ui-info-chip inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-black uppercase tracking-[0.14em]">
                                <Server className="h-3.5 w-3.5" /> API v2 Snapshot
                            </span>
                            {snapshot && (
                                <span className={`inline-flex rounded-full border px-3 py-1 text-xs font-bold ${snapshot.ok ? 'ui-success-chip' : 'ui-warning-chip'}`}>
                                    {snapshot.ok ? 'Connected' : 'Degraded'}
                                </span>
                            )}
                        </div>
                        <h2 className="ui-text mt-3 text-xl font-black">Snapshot Read-only Vendor</h2>
                        <p className="ui-text-muted mt-1 text-sm">
                            Data ringan dari `/api/v2/vendors/health-snapshot` lewat gateway Node. Realtime saldo dan webhook utama sudah memakai API v2.
                        </p>
                    </div>
                    <button
                        onClick={fetchSnapshot}
                        disabled={snapshotLoading}
                        className="ui-muted-action inline-flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-bold disabled:opacity-60"
                    >
                        <RefreshCw className={`h-4 w-4 ${snapshotLoading ? 'animate-spin' : ''}`} /> Refresh Snapshot
                    </button>
                </div>

                {snapshotError && (
                    <div className="ui-warning-chip mt-4 rounded-2xl border px-4 py-3 text-sm font-semibold">
                        {snapshotError}
                    </div>
                )}

                {snapshotLoading && !snapshot ? (
                    <div className="mt-5 h-28 animate-pulse rounded-2xl border ui-border ui-panel-muted" />
                ) : snapshot && (
                    <div className="mt-5 space-y-4">
                        <div className="grid gap-3 sm:grid-cols-5">
                            {[
                                ['Vendor', snapshot.totals.vendors, 'ui-info-chip'],
                                ['Healthy', snapshot.totals.healthy, 'ui-success-chip'],
                                ['Warning', snapshot.totals.warning, 'ui-warning-chip'],
                                ['Critical', snapshot.totals.critical, 'ui-danger-chip'],
                                ['Transaksi', snapshot.totals.transactions_today, 'ui-accent-chip']
                            ].map(([label, value, tone]) => (
                                <div key={String(label)} className={`rounded-2xl border px-4 py-3 ${tone}`}>
                                    <p className="text-xs font-bold uppercase tracking-[0.14em] opacity-80">{label}</p>
                                    <p className="mt-1 text-2xl font-black">{value}</p>
                                </div>
                            ))}
                        </div>

                        <div className="grid gap-3 lg:grid-cols-2">
                            {snapshot.vendors.map((vendor) => {
                                const meta = getHealthMeta(vendor.health);
                                return (
                                    <div key={vendor.key} className="ui-panel-muted rounded-2xl border ui-border p-4">
                                        <div className="flex flex-wrap items-start justify-between gap-3">
                                            <div>
                                                <h3 className="ui-text text-lg font-black">{vendor.label}</h3>
                                                <p className="ui-text-muted mt-1 text-xs">{vendor.health_reason}</p>
                                            </div>
                                            <span className={`rounded-full border px-3 py-1 text-xs font-bold ${meta.className}`}>{meta.label}</span>
                                        </div>
                                        <div className="mt-4 grid gap-2 sm:grid-cols-4">
                                            {[
                                                ['Config', vendor.configured ? 'Ada' : 'Belum', vendor.configured ? 'ui-success-chip' : 'ui-danger-chip'],
                                                ['Aktif', vendor.active ? 'Ya' : 'Tidak', vendor.active ? 'ui-success-chip' : 'ui-danger-chip'],
                                                ['Pending', vendor.transactions_today.pending, 'ui-warning-chip'],
                                                ['Gagal', vendor.transactions_today.failed, 'ui-danger-chip']
                                            ].map(([label, value, tone]) => (
                                                <div key={String(label)} className={`rounded-xl border px-3 py-2 ${tone}`}>
                                                    <p className="text-[10px] font-black uppercase tracking-[0.14em] opacity-75">{label}</p>
                                                    <p className="mt-1 text-sm font-black">{value}</p>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                        <p className="ui-text-muted text-xs">Generated API v2: {formatDateTime(snapshot.generated_at ? new Date(Number(snapshot.generated_at) * 1000).toISOString() : null)} • Source: {snapshot.source}</p>
                    </div>
                )}
            </section>

            {error && (
                <div className="ui-danger-chip flex items-center gap-2 rounded-2xl border px-4 py-3 text-sm font-semibold">
                    <ShieldAlert className="h-4 w-4" /> {error}
                </div>
            )}

            <section className="grid gap-4 md:grid-cols-4">
                {[
                    { label: 'Transaksi Hari Ini', value: totals.transactions, icon: Activity, tone: 'ui-info-chip' },
                    { label: 'Pending / Proses', value: totals.pending, icon: RefreshCw, tone: 'ui-warning-chip' },
                    { label: 'Gagal', value: totals.failed, icon: XCircle, tone: 'ui-danger-chip' },
                    { label: 'Saldo Rendah', value: totals.lowBalance, icon: Wallet, tone: totals.lowBalance > 0 ? 'ui-warning-chip' : 'ui-success-chip' },
                    { label: 'Webhook Rejected', value: totals.webhookRejected, icon: ShieldAlert, tone: 'ui-danger-chip' }
                ].map((card) => {
                    const Icon = card.icon;
                    return (
                        <div key={card.label} className="ui-panel rounded-2xl border ui-border p-5">
                            <div className="flex items-center justify-between gap-3">
                                <p className="ui-text-muted text-xs font-bold uppercase tracking-[0.14em]">{card.label}</p>
                                <span className={`rounded-xl border p-2 ${card.tone}`}><Icon className="h-4 w-4" /></span>
                            </div>
                            <p className="ui-text mt-4 text-3xl font-black">{card.value}</p>
                        </div>
                    );
                })}
            </section>

            {loading ? (
                <div className="grid gap-5 lg:grid-cols-2">
                    {Array.from({ length: 2 }).map((_, index) => <div key={index} className="ui-panel h-80 animate-pulse rounded-[24px] border ui-border" />)}
                </div>
            ) : (
                <section className="grid gap-5 lg:grid-cols-2">
                    {(data?.vendors || []).map((vendor) => {
                        const meta = getHealthMeta(vendor.health);
                        const Icon = meta.icon;
                        const settingsPath = vendor.key === 'digiflazz' ? '/admin/addons/digiflazz' : '/admin/addons/tokovoucher';

                        return (
                            <article key={vendor.key} className="ui-panel overflow-hidden rounded-[24px] border ui-border">
                                <div className="ui-panel-muted border-b ui-border p-5">
                                    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                                        <div>
                                            <div className="flex flex-wrap items-center gap-2">
                                                <h2 className="ui-text text-xl font-black">{vendor.label}</h2>
                                                <span className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-bold ${meta.className}`}>
                                                    <Icon className="h-3.5 w-3.5" /> {meta.label}
                                                </span>
                                            </div>
                                            <p className="ui-text-muted mt-1 text-sm">{vendor.active ? 'Vendor aktif' : 'Vendor nonaktif'} • {vendor.configured ? 'Credential tersedia' : 'Credential belum lengkap'}</p>
                                        </div>
                                        <Link to={settingsPath} className="ui-muted-action inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-bold">
                                            Setting <ExternalLink className="h-3.5 w-3.5" />
                                        </Link>
                                    </div>
                                </div>

                                <div className="space-y-5 p-5">
                                    <div className="grid gap-3 sm:grid-cols-3">
                                        <div className="ui-panel-muted rounded-2xl border ui-border p-4">
                                            <Wallet className="ui-accent-text h-5 w-5" />
                                            <p className="ui-text-muted mt-3 text-xs font-bold uppercase tracking-[0.14em]">Saldo</p>
                                            <p className="ui-text mt-1 text-xl font-black">{formatCurrency(vendor.balance)}</p>
                                            <p className={`mt-1 text-xs ${vendor.lowBalance ? 'ui-warning-text' : vendor.balanceOk ? 'ui-success-text' : 'ui-danger-text'}`}>
                                                {vendor.lowBalance ? `Di bawah threshold ${formatCurrency(vendor.lowBalanceThreshold)}` : vendor.balanceMessage}
                                            </p>
                                        </div>
                                        <div className="ui-panel-muted rounded-2xl border ui-border p-4">
                                            <Activity className="ui-info-text h-5 w-5" />
                                            <p className="ui-text-muted mt-3 text-xs font-bold uppercase tracking-[0.14em]">Success Rate</p>
                                            <p className="ui-text mt-1 text-xl font-black">{vendor.transactionsToday.successRate}%</p>
                                            <p className="ui-text-muted mt-1 text-xs">{vendor.transactionsToday.total} transaksi</p>
                                        </div>
                                        <div className="ui-panel-muted rounded-2xl border ui-border p-4">
                                            <Server className="ui-warning-text h-5 w-5" />
                                            <p className="ui-text-muted mt-3 text-xs font-bold uppercase tracking-[0.14em]">Webhook</p>
                                            <p className="ui-text mt-1 text-xl font-black">{vendor.webhookToday.total}</p>
                                            <p className="ui-text-muted mt-1 text-xs">Rejected {vendor.webhookToday.rejected}</p>
                                        </div>
                                    </div>

                                    <div className="grid gap-3 sm:grid-cols-4">
                                        {[
                                            ['Sukses', vendor.transactionsToday.success, 'ui-success-chip'],
                                            ['Pending', vendor.transactionsToday.pending, 'ui-warning-chip'],
                                            ['Gagal', vendor.transactionsToday.failed, 'ui-danger-chip'],
                                            ['Omset', formatCurrency(vendor.transactionsToday.amountTotal), 'ui-accent-chip']
                                        ].map(([label, value, tone]) => (
                                            <div key={String(label)} className={`rounded-2xl border px-4 py-3 ${tone}`}>
                                                <p className="text-xs font-bold uppercase tracking-[0.14em] opacity-80">{label}</p>
                                                <p className="mt-1 text-lg font-black">{value}</p>
                                            </div>
                                        ))}
                                    </div>

                                    <div className="ui-panel-muted rounded-2xl border ui-border p-4">
                                        <p className="ui-text-muted text-xs font-bold uppercase tracking-[0.14em]">Webhook terakhir</p>
                                        <p className="ui-text mt-2 text-sm font-semibold">{vendor.webhookToday.lastStatus || '-'}</p>
                                        <p className="ui-text-muted mt-1 text-xs">{formatDateTime(vendor.webhookToday.lastAt)}</p>
                                        <p className="ui-text-muted mt-2 text-xs">{vendor.webhookToday.lastMessage || 'Belum ada log webhook'}</p>
                                    </div>
                                </div>
                            </article>
                        );
                    })}
                </section>
            )}

            {!loading && data && data.vendors.some((vendor) => vendor.lowBalance) && (
                <section className="ui-warning-chip rounded-[24px] border p-5">
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                        <div>
                            <div className="flex items-center gap-2">
                                <AlertTriangle className="h-5 w-5" />
                                <h2 className="text-lg font-black">Vendor dengan saldo rendah</h2>
                            </div>
                            <p className="mt-2 text-sm opacity-85">Top up saldo vendor sebelum transaksi gagal karena saldo tidak mencukupi.</p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {data.vendors.filter((vendor) => vendor.lowBalance).map((vendor) => (
                                <Link key={vendor.key} to={vendor.key === 'digiflazz' ? '/admin/addons/digiflazz' : '/admin/addons/tokovoucher'} className="rounded-xl border border-current/25 px-3 py-2 text-xs font-black">
                                    {vendor.label}: {formatCurrency(vendor.balance)}
                                </Link>
                            ))}
                        </div>
                    </div>
                </section>
            )}

            {data && (
                <section className="ui-panel rounded-[24px] border ui-border p-5">
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                        <div>
                            <div className="flex flex-wrap items-center gap-2">
                                <h2 className="ui-text text-xl font-black">Digiflazz Seller Callback</h2>
                                <span className={`inline-flex rounded-full border px-3 py-1 text-xs font-bold ${getHealthMeta(data.seller?.health).className}`}>
                                    {getHealthMeta(data.seller?.health).label}
                                </span>
                            </div>
                            <p className="ui-text-muted mt-1 text-sm">Order seller dan status callback outbound ke Digiflazz.</p>
                        </div>
                        <Link to="/admin/addons/digiflazz-seller" className="ui-accent-solid inline-flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-bold">
                            Buka Seller Center <ExternalLink className="h-4 w-4" />
                        </Link>
                    </div>
                    <div className="mt-5 grid gap-3 sm:grid-cols-5">
                        {[
                            ['Total Order', data.seller.total, 'ui-panel-muted'],
                            ['Pending', data.seller.pending, 'ui-warning-chip'],
                            ['Failed', data.seller.failed, 'ui-danger-chip'],
                            ['Callback Pending', data.seller.callbackPending, 'ui-warning-chip'],
                            ['Callback Delivered', data.seller.callbackDelivered, 'ui-success-chip']
                        ].map(([label, value, tone]) => (
                            <div key={String(label)} className={`rounded-2xl border px-4 py-3 ${tone}`}>
                                <p className="text-xs font-bold uppercase tracking-[0.14em] opacity-80">{label}</p>
                                <p className="mt-1 text-2xl font-black">{value}</p>
                            </div>
                        ))}
                    </div>
                    <p className="ui-text-muted mt-4 text-xs">Generated: {formatDateTime(data.generatedAt)}</p>
                </section>
            )}
        </div>
            {stepUp.dialog}
        </>
    );
}
