import { useEffect, useMemo, useRef, useState } from 'react';
import {
    Activity,
    AlertTriangle,
    CheckCircle2,
    Download,
    ExternalLink,
    ShieldAlert,
    Wallet,
    XCircle,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { apiV2 } from '../../api';
import { useStepUpOrchestration } from '../../auth/useStepUpOrchestration';
import { stepUpActionErrorMessage } from '../../auth/withStepUp';
import {
    parseVendorHealthDiagnostics,
    parseVendorHealthResponse,
    vendorBalanceLabel,
    vendorFreshness,
    vendorHealthErrorMessage,
    vendorHealthMeta,
    vendorSuccessRateLabel,
    type VendorHealthDiagnostics,
    type VendorHealthResponse,
    type VendorHealthState,
} from '../../lib/vendorHealth';

const TONE_CLASS: Record<string, string> = {
    success: 'ui-success-chip',
    warning: 'ui-warning-chip',
    danger: 'ui-danger-chip',
    neutral: 'ui-panel-muted',
};

const stateTone = (state: VendorHealthState) => TONE_CLASS[vendorHealthMeta(state).tone] ?? 'ui-panel-muted';

const formatCount = (value: number) => Number(value || 0).toLocaleString('id-ID');

export default function VendorHealth() {
    const stepUp = useStepUpOrchestration();
    const [health, setHealth] = useState<VendorHealthResponse | null>(null);
    const [healthLoading, setHealthLoading] = useState(true);
    const [healthError, setHealthError] = useState('');
    const [diagnostics, setDiagnostics] = useState<VendorHealthDiagnostics | null>(null);
    const [diagnosticsLoading, setDiagnosticsLoading] = useState(true);
    const [diagnosticsError, setDiagnosticsError] = useState('');
    const [exporting, setExporting] = useState(false);
    const [exportError, setExportError] = useState('');

    const latestHealthRequestId = useRef(0);
    const latestDiagnosticsRequestId = useRef(0);

    const fetchHealth = async () => {
        const requestId = ++latestHealthRequestId.current;
        setHealthLoading(true);
        try {
            const response = await apiV2.get('/vendors/health');
            if (requestId !== latestHealthRequestId.current) return false;
            setHealth(parseVendorHealthResponse(response.data));
            setHealthError('');
            return true;
        } catch (error: unknown) {
            if (requestId !== latestHealthRequestId.current) return false;
            setHealthError(vendorHealthErrorMessage(error, 'Gagal memuat kesehatan vendor'));
            return false;
        } finally {
            if (requestId === latestHealthRequestId.current) setHealthLoading(false);
        }
    };

    const fetchDiagnostics = async () => {
        const requestId = ++latestDiagnosticsRequestId.current;
        setDiagnosticsLoading(true);
        try {
            const response = await apiV2.get('/vendors/health-snapshot');
            if (requestId !== latestDiagnosticsRequestId.current) return false;
            setDiagnostics(parseVendorHealthDiagnostics(response.data));
            setDiagnosticsError('');
            return true;
        } catch (error: unknown) {
            if (requestId !== latestDiagnosticsRequestId.current) return false;
            setDiagnosticsError(vendorHealthErrorMessage(error, 'Gagal memuat diagnostik vendor'));
            return false;
        } finally {
            if (requestId === latestDiagnosticsRequestId.current) setDiagnosticsLoading(false);
        }
    };

    const refreshAll = () => Promise.all([fetchHealth(), fetchDiagnostics()]);

    useEffect(() => {
        void refreshAll();
        const handler = () => {
            void refreshAll();
        };
        window.addEventListener('admin:refresh-current-page', handler);
        return () => window.removeEventListener('admin:refresh-current-page', handler);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleExport = async () => {
        setExporting(true);
        setExportError('');
        try {
            const response = await stepUp.run('exports.sensitive', (config) =>
                apiV2.get('/vendors/health/export', { responseType: 'blob', ...config } as never),
            );
            const disposition = response.headers['content-disposition'] || '';
            const filenameMatch = /filename="?([^";]+)"?/i.exec(disposition);
            const filename =
                filenameMatch?.[1] || `vendor-health-${new Date().toISOString().slice(0, 10)}.csv`;
            const url = URL.createObjectURL(new Blob([response.data], { type: 'text/csv;charset=utf-8;' }));
            const link = document.createElement('a');
            link.href = url;
            link.setAttribute('download', filename);
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
        } catch (error: unknown) {
            const text = stepUpActionErrorMessage(error, 'Gagal ekspor kesehatan vendor');
            if (text) setExportError(text);
        } finally {
            setExporting(false);
        }
    };

    const totals = useMemo(() => {
        const vendors = health?.vendors || [];
        return vendors.reduce(
            (acc, vendor) => ({
                attention:
                    acc.attention +
                    (vendor.health === 'warning' || vendor.health === 'critical' ? 1 : 0),
                pending: acc.pending + vendor.transactionsToday.pending,
                failed: acc.failed + vendor.transactionsToday.failed,
                lowBalance: acc.lowBalance + (vendor.lowBalance ? 1 : 0),
            }),
            { attention: 0, pending: 0, failed: 0, lowBalance: 0 },
        );
    }, [health]);

    const healthFreshness = vendorFreshness(health?.generatedAt ?? null);
    const diagnosticsFreshness = vendorFreshness(diagnostics?.generatedAt ?? null);
    const busy = healthLoading || diagnosticsLoading || exporting;

    return (<>
        <div className="space-y-6" aria-busy={busy ? 'true' : 'false'}>
            <section className="ui-panel-muted flex flex-wrap items-center justify-between gap-3 rounded-2xl border ui-border p-4">
                <p className="ui-text-muted text-sm font-semibold">
                    Saldo dan webhook diperiksa langsung ke penyedia. Segarkan lewat tombol Segarkan Kesehatan Vendor di header.
                </p>
                <button
                    type="button"
                    aria-label="Ekspor CSV kesehatan vendor"
                    onClick={handleExport}
                    disabled={exporting}
                    className="ui-accent-solid inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold disabled:opacity-60"
                >
                    <Download className="h-4 w-4" aria-hidden="true" /> Ekspor CSV
                </button>
            </section>

            {exportError && (
                <div role="alert" className="ui-danger-chip rounded-2xl border px-4 py-3 text-sm font-semibold">
                    {exportError}
                </div>
            )}

            {healthError && (
                <div role="alert" className="ui-danger-chip flex items-center gap-2 rounded-2xl border px-4 py-3 text-sm font-semibold">
                    <ShieldAlert className="h-4 w-4" aria-hidden="true" /> {healthError}
                </div>
            )}

            {health?.partial && health.issues.length > 0 && (
                <div role="alert" className="ui-warning-chip rounded-2xl border px-4 py-3 text-sm font-semibold">
                    Data vendor tidak lengkap: {health.issues.map((issue) => issue.code).join(', ')}
                </div>
            )}

            <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {[
                    {
                        label: 'Perlu perhatian',
                        value: totals.attention,
                        icon: AlertTriangle,
                        tone: totals.attention > 0 ? 'ui-warning-chip' : 'ui-success-chip',
                    },
                    {
                        label: 'Pending',
                        value: totals.pending,
                        icon: Activity,
                        tone: totals.pending > 0 ? 'ui-warning-chip' : 'ui-panel-muted',
                    },
                    {
                        label: 'Gagal',
                        value: totals.failed,
                        icon: XCircle,
                        tone: totals.failed > 0 ? 'ui-danger-chip' : 'ui-panel-muted',
                    },
                    {
                        label: 'Saldo rendah',
                        value: totals.lowBalance,
                        icon: Wallet,
                        tone: totals.lowBalance > 0 ? 'ui-warning-chip' : 'ui-panel-muted',
                    },
                ].map((card) => {
                    const Icon = card.icon;
                    return (
                        <div key={card.label} className="ui-panel rounded-2xl border ui-border p-5">
                            <div className="flex items-center justify-between gap-3">
                                <p className="ui-text-muted text-xs font-bold uppercase tracking-[0.14em]">{card.label}</p>
                                <span className={`rounded-xl border p-2 ${card.tone}`}>
                                    <Icon className="h-4 w-4" aria-hidden="true" />
                                </span>
                            </div>
                            <p className="ui-text mt-4 text-3xl font-black">{formatCount(card.value)}</p>
                        </div>
                    );
                })}
            </section>

            <section className="ui-panel rounded-[24px] border ui-border p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <h2 className="ui-text text-xl font-black">Diagnostik API dan MongoDB</h2>
                    {diagnostics && (
                        <span
                            className={`inline-flex rounded-full border px-3 py-1 text-xs font-bold ${diagnostics.ok ? 'ui-success-chip' : 'ui-warning-chip'}`}
                        >
                            {diagnostics.ok ? 'Snapshot tersedia' : 'Snapshot terganggu'}
                        </span>
                    )}
                </div>
                <p className="ui-text-muted mt-1 text-sm">
                    Ringkasan ringan dari snapshot MongoDB. Kartu vendor di bawah tetap memakai data realtime.
                </p>

                {diagnosticsError && (
                    <div role="alert" className="ui-warning-chip mt-4 rounded-2xl border px-4 py-3 text-sm font-semibold">
                        {diagnosticsError}
                    </div>
                )}

                {diagnostics && (diagnostics.partial || diagnosticsFreshness.state === 'stale') && (
                    <div role="alert" className="ui-warning-chip mt-4 rounded-2xl border px-4 py-3 text-sm font-semibold">
                        {diagnostics.partial && diagnostics.issues.length > 0
                            ? `Snapshot tidak lengkap: ${diagnostics.issues.map((issue) => issue.code).join(', ')}`
                            : null}
                        {diagnostics.partial && diagnosticsFreshness.state === 'stale' ? ' • ' : null}
                        {diagnosticsFreshness.state === 'stale' ? `Snapshot ${diagnosticsFreshness.relativeLabel.toLowerCase()}` : null}
                    </div>
                )}

                {diagnosticsLoading && !diagnostics ? (
                    <div role="status" className="ui-text-muted mt-5 text-sm font-semibold">
                        Memuat diagnostik snapshot...
                    </div>
                ) : diagnostics ? (
                    <div className="mt-5 space-y-4">
                        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                            {[
                                ['Snapshot tersimpan', health ? (health.snapshotPersisted ? 'Ya' : 'Tidak') : '-', health && !health.snapshotPersisted ? 'ui-warning-chip' : 'ui-panel-muted'],
                                ['Sumber', diagnostics.source || '-', 'ui-info-chip'],
                                ['Diperbarui (snapshot)', diagnosticsFreshness.relativeLabel, diagnosticsFreshness.state === 'stale' ? 'ui-warning-chip' : 'ui-panel-muted'],
                                ['Diperbarui (realtime)', healthFreshness.relativeLabel, healthFreshness.state === 'stale' ? 'ui-warning-chip' : 'ui-panel-muted'],
                            ].map(([label, value, tone]) => (
                                <div key={String(label)} className={`rounded-2xl border px-4 py-3 ${tone}`}>
                                    <p className="text-[10px] font-black uppercase tracking-[0.14em] opacity-75">{label}</p>
                                    <p className="mt-1 text-sm font-black">{value}</p>
                                </div>
                            ))}
                        </div>
                        {diagnosticsFreshness.absoluteLabel && (
                            <p className="ui-text-muted text-xs">
                                Waktu snapshot: {diagnosticsFreshness.absoluteLabel}
                                {healthFreshness.absoluteLabel ? ` • Waktu realtime: ${healthFreshness.absoluteLabel}` : null}
                            </p>
                        )}
                    </div>
                ) : null}
            </section>

            {healthLoading && !health ? (
                <div role="status" className="ui-text-muted px-1 text-sm font-semibold">
                    Memuat kesehatan vendor realtime...
                </div>
            ) : (
                <section className="grid gap-5 lg:grid-cols-2">
                    {(health?.vendors || []).map((vendor) => {
                        const meta = vendorHealthMeta(vendor.health);
                        const Icon =
                            vendor.health === 'healthy'
                                ? CheckCircle2
                                : vendor.health === 'warning'
                                  ? AlertTriangle
                                  : vendor.health === 'disabled'
                                    ? Activity
                                    : XCircle;
                        const settingsPath =
                            vendor.key === 'digiflazz' ? '/admin/addons/digiflazz' : '/admin/addons/tokovoucher';
                        return (
                            <article key={vendor.key} className="ui-panel overflow-hidden rounded-[24px] border ui-border">
                                <div className="ui-panel-muted border-b ui-border p-5">
                                    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                                        <div>
                                            <div className="flex flex-wrap items-center gap-2">
                                                <h2 className="ui-text text-xl font-black">{vendor.label}</h2>
                                                <span className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-bold ${stateTone(vendor.health)}`}>
                                                    <Icon className="h-3.5 w-3.5" aria-hidden="true" /> {meta.label}
                                                </span>
                                            </div>
                                            <p className="ui-text-muted mt-1 text-sm">
                                                {vendor.active ? 'Vendor aktif' : 'Vendor nonaktif'} •{' '}
                                                {vendor.configured ? 'Credential tersedia' : 'Credential belum lengkap'}
                                            </p>
                                        </div>
                                        <Link
                                            to={settingsPath}
                                            className="ui-muted-action inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-bold"
                                        >
                                            Pengaturan <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                                        </Link>
                                    </div>
                                </div>

                                <div className="space-y-5 p-5">
                                    <div className="grid gap-3 sm:grid-cols-3">
                                        <div className="ui-panel-muted rounded-2xl border ui-border p-4">
                                            <Wallet className="ui-accent-text h-5 w-5" aria-hidden="true" />
                                            <p className="ui-text-muted mt-3 text-xs font-bold uppercase tracking-[0.14em]">Saldo</p>
                                            <p className="ui-text mt-1 text-xl font-black">
                                                {vendorBalanceLabel(vendor.balanceOk, vendor.balance)}
                                            </p>
                                            <p
                                                className={`mt-1 text-xs ${vendor.lowBalance ? 'ui-warning-text' : vendor.balanceOk ? 'ui-success-text' : 'ui-danger-text'}`}
                                            >
                                                {vendor.lowBalance && vendor.balance !== null
                                                    ? `Di bawah ambang ${vendorBalanceLabel(true, vendor.lowBalanceThreshold)}`
                                                    : vendor.balanceMessage || 'Tidak tersedia'}
                                            </p>
                                        </div>
                                        <div className="ui-panel-muted rounded-2xl border ui-border p-4">
                                            <Activity className="ui-info-text h-5 w-5" aria-hidden="true" />
                                            <p className="ui-text-muted mt-3 text-xs font-bold uppercase tracking-[0.14em]">Tingkat sukses</p>
                                            <p className="ui-text mt-1 text-xl font-black">
                                                {vendorSuccessRateLabel(vendor.transactionsToday.total, vendor.transactionsToday.successRate)}
                                            </p>
                                            <p className="ui-text-muted mt-1 text-xs">
                                                {formatCount(vendor.transactionsToday.total)} transaksi
                                            </p>
                                        </div>
                                        <div className="ui-panel-muted rounded-2xl border ui-border p-4">
                                            <Activity className="ui-warning-text h-5 w-5" aria-hidden="true" />
                                            <p className="ui-text-muted mt-3 text-xs font-bold uppercase tracking-[0.14em]">Webhook</p>
                                            <p className="ui-text mt-1 text-xl font-black">{formatCount(vendor.webhookToday.total)}</p>
                                            <p className="ui-text-muted mt-1 text-xs">
                                                Ditolak {formatCount(vendor.webhookToday.rejected)}
                                            </p>
                                        </div>
                                    </div>

                                    <div className="grid gap-3 sm:grid-cols-4">
                                        {[
                                            ['Sukses', formatCount(vendor.transactionsToday.success), vendor.transactionsToday.success > 0 ? 'ui-success-chip' : 'ui-panel-muted'],
                                            ['Pending', formatCount(vendor.transactionsToday.pending), vendor.transactionsToday.pending > 0 ? 'ui-warning-chip' : 'ui-panel-muted'],
                                            ['Gagal', formatCount(vendor.transactionsToday.failed), vendor.transactionsToday.failed > 0 ? 'ui-danger-chip' : 'ui-panel-muted'],
                                            ['Omset', vendorBalanceLabel(true, vendor.transactionsToday.amountTotal), 'ui-accent-chip'],
                                        ].map(([label, value, tone]) => (
                                            <div key={String(label)} className={`rounded-2xl border px-4 py-3 ${tone}`}>
                                                <p className="text-xs font-bold uppercase tracking-[0.14em] opacity-80">{label}</p>
                                                <p className="mt-1 text-lg font-black">{value}</p>
                                            </div>
                                        ))}
                                    </div>

                                    <div className="ui-panel-muted rounded-2xl border ui-border p-4">
                                        <p className="ui-text-muted text-xs font-bold uppercase tracking-[0.14em]">Webhook terakhir</p>
                                        <p className="ui-text mt-2 text-sm font-semibold">
                                            {vendor.webhookToday.lastStatus || 'Belum ada status'}
                                        </p>
                                        <p className="ui-text-muted mt-1 text-xs">
                                            {vendor.webhookToday.lastAt
                                                ? vendorFreshness(vendor.webhookToday.lastAt).absoluteLabel
                                                : 'Belum ada log webhook'}
                                        </p>
                                        {vendor.webhookToday.lastMessage && (
                                            <p className="ui-text-muted mt-2 text-xs">{vendor.webhookToday.lastMessage}</p>
                                        )}
                                    </div>
                                </div>
                            </article>
                        );
                    })}
                </section>
            )}

            {health?.seller && (
                <section className="ui-panel rounded-[24px] border ui-border p-5">
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                        <div>
                            <div className="flex flex-wrap items-center gap-2">
                                <h2 className="ui-text text-xl font-black">Callback Seller Digiflazz</h2>
                                <span className={`inline-flex rounded-full border px-3 py-1 text-xs font-bold ${stateTone(health.seller.health)}`}>
                                    {vendorHealthMeta(health.seller.health).label}
                                </span>
                            </div>
                            <p className="ui-text-muted mt-1 text-sm">
                                Order seller dan status callback outbound ke Digiflazz.
                            </p>
                        </div>
                        <Link
                            to="/admin/addons/digiflazz-seller"
                            className="ui-accent-solid inline-flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-bold"
                        >
                            Buka Seller Center <ExternalLink className="h-4 w-4" aria-hidden="true" />
                        </Link>
                    </div>
                    <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                        {[
                            ['Total order', formatCount(health.seller.total), 'ui-panel-muted'],
                            ['Pending', formatCount(health.seller.pending), health.seller.pending > 0 ? 'ui-warning-chip' : 'ui-panel-muted'],
                            ['Gagal', formatCount(health.seller.failed), health.seller.failed > 0 ? 'ui-danger-chip' : 'ui-panel-muted'],
                            [
                                'Callback tertunda',
                                formatCount(health.seller.callbackPending),
                                health.seller.callbackPending > 0 ? 'ui-warning-chip' : 'ui-panel-muted',
                            ],
                        ].map(([label, value, tone]) => (
                            <div key={String(label)} className={`rounded-2xl border px-4 py-3 ${tone}`}>
                                <p className="text-[10px] font-black uppercase tracking-[0.14em] opacity-75">{label}</p>
                                <p className="mt-1 text-2xl font-black">{value}</p>
                            </div>
                        ))}
                    </div>
                    <p className="ui-text-muted mt-4 text-xs">
                        Callback terkirim: {formatCount(health.seller.callbackDelivered)}
                    </p>
                </section>
            )}

            {health && health.vendors.some((vendor) => vendor.lowBalance) && (
                <section className="ui-warning-chip rounded-[24px] border p-5">
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                        <div>
                            <div className="flex items-center gap-2">
                                <AlertTriangle className="h-5 w-5" aria-hidden="true" />
                                <h2 className="text-lg font-black">Vendor dengan saldo rendah</h2>
                            </div>
                            <p className="mt-2 text-sm opacity-85">
                                Top up saldo vendor sebelum transaksi gagal karena saldo tidak mencukupi.
                            </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {health.vendors
                                .filter((vendor) => vendor.lowBalance)
                                .map((vendor) => (
                                    <Link
                                        key={vendor.key}
                                        to={vendor.key === 'digiflazz' ? '/admin/addons/digiflazz' : '/admin/addons/tokovoucher'}
                                        className="rounded-xl border border-current/25 px-3 py-2 text-xs font-black"
                                    >
                                        {vendor.label}: {vendorBalanceLabel(true, vendor.balance)}
                                    </Link>
                                ))}
                        </div>
                    </div>
                </section>
            )}
        </div>
        {stepUp.dialog}
    </>);
}
