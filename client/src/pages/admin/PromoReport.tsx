import { useCallback, useEffect, useState } from 'react';
import { apiV2 } from '../../api';
import {
    Activity,
    AlertCircle,
    Download,
    Gift,
    Loader2,
    RefreshCw,
    Ticket,
    TrendingDown,
    Zap,
} from 'lucide-react';

type CountAmount = { count: number; amount: number };

type PromoReport = {
    ok: boolean;
    range?: { start?: string; end?: string };
    balanceVouchersRedeemed?: CountAmount;
    discountVouchersApplied?: CountAmount;
    giveaways?: CountAmount;
    flashSalesLive?: number;
    idleBalanceVouchers?: number;
    openDiscountVouchers?: number;
};

const formatCurrency = (value: number) => `Rp ${Math.max(0, value || 0).toLocaleString('id-ID')}`;
const formatNumber = (value: number) => Math.max(0, value || 0).toLocaleString('id-ID');

export default function PromoReport() {
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [data, setData] = useState<PromoReport | null>(null);
    const [startDate, setStartDate] = useState('');
    const [endDate, setEndDate] = useState('');

    const fetchReport = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const params = new URLSearchParams();
            if (startDate) params.set('startDate', startDate);
            if (endDate) params.set('endDate', endDate);
            const suffix = params.toString();
            const res = await apiV2.get(`/reports/promo${suffix ? `?${suffix}` : ''}`);
            setData(res.data);
        } catch (err: any) {
            setError(err.response?.data?.message || 'Gagal memuat laporan promo');
            setData(null);
        } finally {
            setLoading(false);
        }
    }, [startDate, endDate]);

    useEffect(() => {
        fetchReport();
    }, [fetchReport]);

    useEffect(() => {
        const handler = () => fetchReport();
        window.addEventListener('admin:refresh-current-page', handler);
        return () => window.removeEventListener('admin:refresh-current-page', handler);
    }, [fetchReport]);

    const cards = [
        {
            title: 'Voucher saldo ditukar',
            count: data?.balanceVouchersRedeemed?.count || 0,
            amount: data?.balanceVouchersRedeemed?.amount || 0,
            icon: Ticket,
            tone: 'ui-accent-chip',
        },
        {
            title: 'Diskon checkout',
            count: data?.discountVouchersApplied?.count || 0,
            amount: data?.discountVouchersApplied?.amount || 0,
            icon: TrendingDown,
            tone: 'ui-warning-chip',
        },
        {
            title: 'Giveaway dikredit',
            count: data?.giveaways?.count || 0,
            amount: data?.giveaways?.amount || 0,
            icon: Gift,
            tone: 'ui-success-chip',
        },
        {
            title: 'Flash sale live',
            count: data?.flashSalesLive || 0,
            amount: null as number | null,
            icon: Zap,
            tone: 'ui-info-chip',
        },
    ];

    const totalPromoCost =
        (data?.balanceVouchersRedeemed?.amount || 0)
        + (data?.discountVouchersApplied?.amount || 0)
        + (data?.giveaways?.amount || 0);

    return (
        <div className="space-y-6">
            <div className="ui-panel rounded-2xl border ui-border p-5">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                    <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.18em] ui-accent-text">Laporan Promo</p>
                        <h1 className="mt-1 text-2xl font-black ui-text">Biaya & aktivitas kampanye</h1>
                        <p className="mt-1 text-sm ui-text-muted">
                            Voucher saldo, diskon checkout, giveaway, dan flash sale dalam satu ringkasan.
                        </p>
                    </div>
                    <div className="flex flex-wrap items-end gap-2">
                        <label className="space-y-1 text-xs ui-text-muted">
                            Dari
                            <input
                                type="date"
                                value={startDate}
                                onChange={(e) => setStartDate(e.target.value)}
                                className="block rounded-xl border ui-field px-3 py-2 text-sm"
                            />
                        </label>
                        <label className="space-y-1 text-xs ui-text-muted">
                            Sampai
                            <input
                                type="date"
                                value={endDate}
                                onChange={(e) => setEndDate(e.target.value)}
                                className="block rounded-xl border ui-field px-3 py-2 text-sm"
                            />
                        </label>
                        <button
                            type="button"
                            onClick={fetchReport}
                            className="inline-flex items-center gap-2 rounded-xl ui-accent-solid px-4 py-2.5 text-sm font-semibold"
                        >
                            <RefreshCw className="h-4 w-4" />
                            Muat
                        </button>
                        <button
                            type="button"
                            onClick={async () => {
                                try {
                                    const params = new URLSearchParams();
                                    if (startDate) params.set('startDate', startDate);
                                    if (endDate) params.set('endDate', endDate);
                                    const suffix = params.toString();
                                    const res = await apiV2.get(`/reports/promo/export${suffix ? `?${suffix}` : ''}`, {
                                        responseType: 'blob',
                                    });
                                    const blob = new Blob([res.data], { type: 'text/csv;charset=utf-8;' });
                                    const url = URL.createObjectURL(blob);
                                    const link = document.createElement('a');
                                    link.href = url;
                                    link.download = `promo-report-${new Date().toISOString().slice(0, 10)}.csv`;
                                    document.body.appendChild(link);
                                    link.click();
                                    link.remove();
                                    URL.revokeObjectURL(url);
                                } catch (err: any) {
                                    setError(err.response?.data?.message || 'Gagal export CSV promo');
                                }
                            }}
                            className="inline-flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-semibold ui-muted-action"
                        >
                            <Download className="h-4 w-4" />
                            Export CSV
                        </button>
                    </div>
                </div>
            </div>

            {error ? (
                <div className="ui-danger-chip flex items-center gap-2 rounded-xl border px-4 py-3 text-sm">
                    <AlertCircle className="h-4 w-4" />
                    {error}
                </div>
            ) : null}

            {loading ? (
                <div className="flex justify-center py-16">
                    <Loader2 className="h-8 w-8 animate-spin ui-accent-text" />
                </div>
            ) : (
                <>
                    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                        {cards.map((card) => {
                            const Icon = card.icon;
                            return (
                                <div key={card.title} className="ui-panel-muted rounded-2xl border ui-border p-4">
                                    <div className="flex items-start justify-between gap-3">
                                        <div>
                                            <p className="text-xs uppercase tracking-[0.16em] ui-text-muted">{card.title}</p>
                                            <p className="mt-2 text-3xl font-black ui-text">{formatNumber(card.count)}</p>
                                            {card.amount != null ? (
                                                <p className="mt-1 text-sm font-semibold ui-accent-text">{formatCurrency(card.amount)}</p>
                                            ) : (
                                                <p className="mt-1 text-sm ui-text-muted">sedang berjalan</p>
                                            )}
                                        </div>
                                        <div className={`rounded-xl border p-2.5 ${card.tone}`}>
                                            <Icon className="h-5 w-5" />
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>

                    <div className="grid gap-4 lg:grid-cols-3">
                        <div className="ui-panel rounded-2xl border ui-border p-5 lg:col-span-2">
                            <div className="flex items-center gap-2">
                                <Activity className="h-5 w-5 ui-accent-text" />
                                <h2 className="text-lg font-bold ui-text">Estimasi biaya promo (rentang aktif)</h2>
                            </div>
                            <p className="mt-3 text-3xl font-black ui-danger-text">{formatCurrency(totalPromoCost)}</p>
                            <p className="mt-2 text-sm ui-text-muted">
                                Jumlah: voucher saldo ditukar + potongan diskon checkout + giveaway dikredit.
                                Flash sale dihitung lewat harga jual (bukan baris terpisah di sini).
                            </p>
                            <div className="mt-4 grid gap-2 sm:grid-cols-3 text-sm">
                                <div className="rounded-xl border ui-border ui-panel-muted p-3">
                                    <p className="ui-text-muted">Saldo voucher</p>
                                    <p className="font-bold ui-text">{formatCurrency(data?.balanceVouchersRedeemed?.amount || 0)}</p>
                                </div>
                                <div className="rounded-xl border ui-border ui-panel-muted p-3">
                                    <p className="ui-text-muted">Diskon checkout</p>
                                    <p className="font-bold ui-text">{formatCurrency(data?.discountVouchersApplied?.amount || 0)}</p>
                                </div>
                                <div className="rounded-xl border ui-border ui-panel-muted p-3">
                                    <p className="ui-text-muted">Giveaway</p>
                                    <p className="font-bold ui-text">{formatCurrency(data?.giveaways?.amount || 0)}</p>
                                </div>
                            </div>
                        </div>
                        <div className="ui-panel rounded-2xl border ui-border p-5 space-y-4">
                            <h2 className="text-lg font-bold ui-text">Antrian bersihkan</h2>
                            <div className="rounded-xl border ui-border ui-panel-muted p-3">
                                <p className="text-xs ui-text-muted">Voucher saldo idle &gt;30 hari</p>
                                <p className="text-2xl font-black ui-warning-text">{formatNumber(data?.idleBalanceVouchers || 0)}</p>
                            </div>
                            <div className="rounded-xl border ui-border ui-panel-muted p-3">
                                <p className="text-xs ui-text-muted">Diskon masih ada slot</p>
                                <p className="text-2xl font-black ui-accent-text">{formatNumber(data?.openDiscountVouchers || 0)}</p>
                            </div>
                        </div>
                    </div>
                </>
            )}
        </div>
    );
}
