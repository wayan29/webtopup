import { Link, useOutletContext } from 'react-router-dom';
import { Loader2, Shield } from 'lucide-react';
import type { DashboardOutletContext, DashboardTransaction } from './types';

const getStatusBadge = (status: string) => {
    switch (status) {
        case 'success':
            return <span className="inline-flex rounded-full bg-emerald-500/20 px-2.5 py-1 text-[11px] font-semibold text-emerald-400 border border-emerald-500/30">Sukses</span>;
        case 'pending':
            return <span className="inline-flex rounded-full bg-amber-500/20 px-2.5 py-1 text-[11px] font-semibold text-amber-400 border border-amber-500/30">Menunggu</span>;
        case 'processing':
            return <span className="inline-flex rounded-full bg-sky-500/20 px-2.5 py-1 text-[11px] font-semibold text-sky-400 border border-sky-500/30">Proses</span>;
        default:
            return <span className="inline-flex rounded-full bg-rose-500/20 px-2.5 py-1 text-[11px] font-semibold text-rose-400 border border-rose-500/30">Gagal</span>;
    }
};

const getSourceBadge = (transaction: DashboardTransaction) => (
    transaction.source === 'payment_gateway'
        ? <span className="ui-info-chip inline-flex rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.2em]">Gateway</span>
        : <span className="ui-accent-chip inline-flex rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.2em]">Saldo</span>
);

export default function DashboardIndex() {
    const { transactions, loading } = useOutletContext<DashboardOutletContext>();

    const todayLabel = new Date().toDateString();
    const todayTransactions = transactions.filter((transaction) => (
        new Date(transaction.createdAt).toDateString() === todayLabel
    ));

    const stats = {
        total: todayTransactions.length,
        totalSales: todayTransactions
            .filter((transaction) => transaction.status === 'success')
            .reduce((sum, transaction) => sum + transaction.amount, 0),
        success: todayTransactions.filter((transaction) => transaction.status === 'success').length,
        pending: todayTransactions.filter((transaction) => transaction.status === 'pending').length,
        processing: todayTransactions.filter((transaction) => transaction.status === 'processing').length,
        failed: todayTransactions.filter((transaction) => transaction.status === 'failed').length
    };
    const gatewayToday = todayTransactions.filter((transaction) => transaction.source === 'payment_gateway').length;
    const balanceToday = todayTransactions.filter((transaction) => transaction.source !== 'payment_gateway').length;
    const featuredStats = [
        {
            label: 'Member Aktif Hari Ini',
            value: stats.total.toLocaleString('id-ID'),
            detail: `${stats.success} transaksi berhasil diproses`,
            className: 'ui-panel-muted ui-border'
        },
        {
            label: 'Order Sukses',
            value: stats.success.toLocaleString('id-ID'),
            detail: `Omset Rp ${stats.totalSales.toLocaleString('id-ID')}`,
            className: 'bg-gradient-to-br from-[#1a1a2e] to-[#252540] border-orange-500/30'
        },
        {
            label: 'Pending + Proses',
            value: `${stats.pending + stats.processing}`,
            detail: 'Perlu dipantau agar tidak terlambat',
            className: 'ui-panel-muted ui-border'
        },
        {
            label: 'Completion Rate',
            value: stats.total > 0 ? `${Math.round((stats.success / stats.total) * 100)}%` : '0%',
            detail: 'Member lebih mudah lanjut belanja',
            className: 'ui-panel-muted ui-border'
        }
    ];

    return (
        <>
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_0.85fr]">
                <div className="rounded-[28px] border ui-border bg-[var(--ui-card-bg)]/70 p-5">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                            <p className="text-[11px] font-semibold uppercase tracking-[0.3em] ui-text-muted">Dashboard Utama</p>
                            <h2 className="mt-2 text-3xl font-black tracking-tight ui-text">Ringkasan aktivitas member</h2>
                            <p className="mt-2 max-w-2xl text-sm leading-7 ui-text-muted">
                                Nuansa dark premium dengan metrik harian yang lebih cepat dibaca. Fokus utamanya tetap transaksi sukses, order yang masih menunggu, dan kesehatan aktivitas akun.
                            </p>
                        </div>
                        <span className="rounded-full bg-orange-500/10 border border-orange-500/20 px-3 py-1 text-xs font-semibold ui-accent-text">Hari Ini</span>
                    </div>

                    <div className="mt-5 grid gap-3 sm:grid-cols-2 2xl:grid-cols-4">
                        {featuredStats.map((item) => (
                            <div
                                key={item.label}
                                className={`rounded-[24px] border p-4 ${item.className}`}
                            >
                                <p className="text-[11px] font-semibold uppercase tracking-[0.26em] ui-text-muted">{item.label}</p>
                                <p className="mt-3 text-4xl font-black ui-text">{item.value}</p>
                                <p className="mt-2 text-sm leading-6 ui-text-muted">{item.detail}</p>
                            </div>
                        ))}
                    </div>
                </div>

                <div className="rounded-[28px] border ui-border bg-[var(--ui-card-muted)] p-5">
                    <div className="flex items-start justify-between gap-3">
                        <div>
                            <p className="text-[11px] font-semibold uppercase tracking-[0.3em] ui-text-muted">Aktivitas Member</p>
                            <h3 className="mt-2 text-2xl font-black leading-tight ui-text">Timeline yang lebih nyaman dipantau</h3>
                        </div>
                        <Shield className="h-9 w-9 ui-accent-text" />
                    </div>
                    <div className="mt-5 space-y-4">
                        <div className="flex items-start gap-3">
                            <span className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--ui-card-bg)] border ui-border text-xs font-bold ui-accent-text">1</span>
                            <div>
                                <p className="text-sm font-semibold ui-text">Transaksi sukses sudah lebih mudah di-scan</p>
                                <p className="mt-1 text-sm leading-6 ui-text-muted">Badge saldo dan gateway dipisah agar sumber order tidak lagi membingungkan.</p>
                            </div>
                        </div>
                        <div className="flex items-start gap-3">
                            <span className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--ui-card-bg)] border ui-border text-xs font-bold ui-accent-text">2</span>
                            <div>
                                <p className="text-sm font-semibold ui-text">Pending dan proses tetap terlihat jelas</p>
                                <p className="mt-1 text-sm leading-6 ui-text-muted">Order yang perlu dipantau tetap muncul sebagai fokus operasional harian.</p>
                            </div>
                        </div>
                        <div className="flex items-start gap-3">
                            <span className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--ui-card-bg)] border ui-border text-xs font-bold text-[#6682a4]">3</span>
                            <div>
                                <p className="text-sm font-semibold ui-text">Distribusi order kini lebih mudah dibaca</p>
                                <p className="mt-1 text-sm leading-6 ui-text-muted">Saldo internal: <span className="font-semibold ui-accent-text">{balanceToday}</span> • Gateway: <span className="font-semibold text-[#6682a4]">{gatewayToday}</span></p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_0.85fr]">
                <div className="rounded-[28px] border ui-border bg-[var(--ui-card-bg)]/70 overflow-hidden">
                    <div className="flex items-center justify-between border-b ui-border px-5 py-4 bg-[var(--ui-card-muted)]/30">
                        <div>
                            <p className="text-[11px] font-semibold uppercase tracking-[0.28em] ui-text-muted">Transaksi Terbaru</p>
                            <h3 className="mt-1 text-xl font-black ui-text">Timeline order hari ini</h3>
                        </div>
                        <Link to="/dashboard/history" className="rounded-full border ui-border bg-[var(--ui-card-muted)] px-3 py-1.5 text-sm font-semibold ui-text-muted transition-colors hover:bg-[var(--ui-card-bg)] hover:text-[var(--ui-text)]">
                            Lihat Semua
                        </Link>
                    </div>
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b ui-border bg-[var(--ui-card-bg)]">
                                    <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-[0.24em] ui-text-muted">Invoice</th>
                                    <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-[0.24em] ui-text-muted">Produk</th>
                                    <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-[0.24em] ui-text-muted">Tujuan</th>
                                    <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-[0.24em] ui-text-muted">Harga</th>
                                    <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-[0.24em] ui-text-muted">Status</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-[var(--ui-border)]">
                                {loading ? (
                                    <tr>
                                        <td colSpan={5} className="py-12 text-center ui-text-muted">
                                            <Loader2 className="mx-auto h-5 w-5 animate-spin text-orange-500" />
                                        </td>
                                    </tr>
                                ) : todayTransactions.length === 0 ? (
                                    <tr>
                                        <td colSpan={5} className="py-12 text-center ui-text-muted">Belum ada transaksi hari ini</td>
                                    </tr>
                                ) : (
                                    todayTransactions.slice(0, 5).map((transaction) => (
                                        <tr key={transaction._id} className="hover:bg-[var(--ui-card-muted)]/50 transition-colors">
                                            <td className="px-5 py-4 ui-text">
                                                <div className="font-semibold">{transaction.invoiceNumber || transaction._id.slice(-8).toUpperCase()}</div>
                                                <div className="mt-1">{getSourceBadge(transaction)}</div>
                                            </td>
                                            <td className="px-5 py-4 font-medium ui-text">{transaction.product?.name || '-'}</td>
                                            <td className="px-5 py-4 ui-text-muted">{transaction.target}</td>
                                            <td className="px-5 py-4 font-semibold ui-text">Rp {transaction.amount.toLocaleString('id-ID')}</td>
                                            <td className="px-5 py-4">{getStatusBadge(transaction.status)}</td>
                                        </tr>
                                    ))
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>

                <div className="space-y-4">
                    <div className="rounded-[28px] border ui-border bg-[var(--ui-card-bg)]/70 p-5">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.3em] ui-text-muted">Distribusi Order</p>
                        <h3 className="mt-3 text-2xl font-black ui-text">Sumber transaksi</h3>
                        <div className="mt-5 space-y-4">
                            <div>
                                <div className="mb-2 flex items-center justify-between text-sm">
                                    <span className="font-semibold ui-text">Saldo Internal</span>
                                    <span className="ui-accent-text">{balanceToday} order</span>
                                </div>
                                <div className="h-3 rounded-full bg-[var(--ui-card-muted)] overflow-hidden">
                                    <div
                                        className="h-3 rounded-full bg-gradient-to-r from-orange-400 to-amber-600 backdrop-blur"
                                        style={{ width: `${stats.total > 0 ? Math.max((balanceToday / stats.total) * 100, balanceToday > 0 ? 6 : 0) : 0}%` }}
                                    />
                                </div>
                            </div>
                            <div>
                                <div className="mb-2 flex items-center justify-between text-sm">
                                    <span className="font-semibold ui-text">Payment Gateway</span>
                                    <span className="text-[#6b86a3]">{gatewayToday} order</span>
                                </div>
                                <div className="h-3 rounded-full bg-[var(--ui-card-muted)] overflow-hidden">
                                    <div
                                        className="h-3 rounded-full bg-gradient-to-r from-[#5d7ea8] to-[#9eb9d4] backdrop-blur"
                                        style={{ width: `${stats.total > 0 ? Math.max((gatewayToday / stats.total) * 100, gatewayToday > 0 ? 6 : 0) : 0}%` }}
                                    />
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="rounded-[28px] border ui-border bg-[var(--ui-card-muted)] p-5">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.3em] ui-text-muted">Kualitas Operasional</p>
                        <div className="mt-4 space-y-3">
                            <div className="rounded-[22px] border ui-border bg-[var(--ui-card-bg)]/70 p-4">
                                <p className="text-sm font-semibold ui-text">Order gagal</p>
                                <p className="mt-2 text-3xl font-black ui-text">{stats.failed}</p>
                                <p className="mt-1 text-sm ui-text-muted">Tetap terlihat agar mudah dievaluasi.</p>
                            </div>
                            <div className="rounded-[22px] border ui-border bg-gradient-to-br from-[#1a1a2e] to-[#252540] p-4">
                                <p className="text-sm font-semibold ui-text">Akses aman</p>
                                <p className="mt-2 text-lg font-bold ui-text">Perbarui kata sandi rutin</p>
                                <p className="mt-1 text-sm ui-text-muted">Cek aktivitas login di halaman akun agar area member tetap aman.</p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </>
    );
}
