import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { CheckCircle, ChevronLeft, ChevronRight, Copy, Eye, Loader2, X } from 'lucide-react';
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

const getPaymentStatusBadge = (paymentStatus?: string) => {
    switch (paymentStatus) {
        case 'paid':
            return <span className="inline-flex rounded-full bg-emerald-500/20 px-2.5 py-1 text-[11px] font-semibold text-emerald-400 border border-emerald-500/30">Pembayaran Masuk</span>;
        case 'waiting_payment':
            return <span className="inline-flex rounded-full bg-amber-500/20 px-2.5 py-1 text-[11px] font-semibold text-amber-400 border border-amber-500/30">Menunggu Bayar</span>;
        case 'expired':
            return <span className="inline-flex rounded-full bg-rose-500/20 px-2.5 py-1 text-[11px] font-semibold text-rose-400 border border-rose-500/30">Kadaluarsa</span>;
        case 'cancelled':
            return <span className="inline-flex rounded-full bg-slate-500/20 px-2.5 py-1 text-[11px] font-semibold text-gray-300 border border-slate-500/30">Dibatalkan</span>;
        default:
            return null;
    }
};

const getSourceBadge = (transaction: DashboardTransaction) => (
    transaction.source === 'payment_gateway'
        ? <span className="inline-flex rounded-full bg-[#1a1a2e] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-[#6b86a3] border border-[#3a3a5a]">Gateway</span>
        : <span className="inline-flex rounded-full bg-[#252540] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-orange-400 border border-orange-500/30">Saldo</span>
);

export default function DashboardHistory() {
    const { transactions, loading, error } = useOutletContext<DashboardOutletContext>();
    const [page, setPage] = useState(1);
    const [limit] = useState(10);
    const [filters, setFilters] = useState({ status: '', startDate: '', endDate: '' });
    const [selectedTransaction, setSelectedTransaction] = useState<DashboardTransaction | null>(null);
    const [copied, setCopied] = useState<string | null>(null);

    const copyToClipboard = (text: string, field: string) => {
        navigator.clipboard.writeText(text);
        setCopied(field);
        window.setTimeout(() => setCopied(null), 2000);
    };

    const filteredTransactions = transactions.filter((transaction) => {
        if (filters.status && transaction.status !== filters.status) return false;
        if (filters.startDate && new Date(transaction.createdAt) < new Date(filters.startDate)) return false;
        if (filters.endDate) {
            const endDate = new Date(filters.endDate);
            endDate.setHours(23, 59, 59, 999);
            if (new Date(transaction.createdAt) > endDate) return false;
        }
        return true;
    });

    const totalPages = Math.max(1, Math.ceil(filteredTransactions.length / limit));
    const currentPage = Math.min(page, totalPages);
    const paginatedTransactions = filteredTransactions.slice((currentPage - 1) * limit, currentPage * limit);

    const inputClass = 'w-full rounded-2xl border border-[#3a3a5a] bg-[#252540] px-3 py-2.5 text-sm text-white focus:border-orange-500 focus:outline-none';

    return (
        <>
            <div className="rounded-[28px] border border-[#3a3a5a] bg-[#1a1a2e] p-5">
                <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-gray-500">History Member</p>
                <h1 className="mt-2 text-3xl font-black text-white">Riwayat Transaksi</h1>
                <p className="mt-2 text-sm leading-7 text-gray-400">Daftar transaksi saldo dan payment gateway dalam satu timeline yang lebih mudah dibaca.</p>
            </div>

            <div className="rounded-[28px] border border-[#3a3a5a] bg-[#1a1a2e] p-4">
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                    <select
                        value={filters.status}
                        onChange={(event) => {
                            setFilters({ ...filters, status: event.target.value });
                            setPage(1);
                        }}
                        className={inputClass}
                    >
                        <option value="">Semua Status</option>
                        <option value="success">Sukses</option>
                        <option value="pending">Menunggu</option>
                        <option value="processing">Proses</option>
                        <option value="failed">Gagal</option>
                    </select>
                    <input
                        type="date"
                        value={filters.startDate}
                        onChange={(event) => {
                            setFilters({ ...filters, startDate: event.target.value });
                            setPage(1);
                        }}
                        className={inputClass}
                        style={{ colorScheme: 'dark' }}
                    />
                    <input
                        type="date"
                        value={filters.endDate}
                        onChange={(event) => {
                            setFilters({ ...filters, endDate: event.target.value });
                            setPage(1);
                        }}
                        className={inputClass}
                        style={{ colorScheme: 'dark' }}
                    />
                    <button
                        onClick={() => {
                            setFilters({ status: '', startDate: '', endDate: '' });
                            setPage(1);
                        }}
                        className="px-4 py-2.5 bg-[#252540] hover:bg-[#3a3a5a] border border-[#3a3a5a] text-white rounded-2xl text-sm font-semibold transition-colors"
                    >
                        Reset
                    </button>
                </div>
            </div>

            <div className="overflow-hidden rounded-[28px] border border-[#3a3a5a] bg-[#1a1a2e]">
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-[#3a3a5a] bg-[#252540]/30">
                                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-[0.24em] text-gray-500">Invoice</th>
                                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-[0.24em] text-gray-500">Produk</th>
                                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-[0.24em] text-gray-500">Tujuan</th>
                                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-[0.24em] text-gray-500">Harga</th>
                                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-[0.24em] text-gray-500">Status</th>
                                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-[0.24em] text-gray-500">Tanggal</th>
                                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-[0.24em] text-gray-500">Aksi</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-[#3a3a5a]">
                            {loading ? (
                                <tr>
                                    <td colSpan={7} className="text-center py-8">
                                        <Loader2 className="w-5 h-5 animate-spin mx-auto text-orange-500" />
                                    </td>
                                </tr>
                            ) : paginatedTransactions.length === 0 ? (
                                <tr>
                                    <td colSpan={7} className="text-center py-8 text-gray-500">
                                        {error ? 'Data transaksi belum tersedia' : 'Tidak ada transaksi'}
                                    </td>
                                </tr>
                            ) : (
                                paginatedTransactions.map((transaction) => (
                                    <tr key={transaction._id} className="hover:bg-[#252540]/50 transition-colors">
                                        <td className="px-4 py-3 text-white">
                                            <div className="font-semibold">{transaction.invoiceNumber || transaction._id.slice(-8).toUpperCase()}</div>
                                            <div className="mt-1 flex flex-wrap gap-1.5">
                                                {getSourceBadge(transaction)}
                                                {getPaymentStatusBadge(transaction.paymentStatus)}
                                            </div>
                                        </td>
                                        <td className="px-4 py-3 font-medium text-white">{transaction.product?.name || '-'}</td>
                                        <td className="px-4 py-3 text-gray-400">{transaction.target}</td>
                                        <td className="px-4 py-3 font-semibold text-white">Rp {transaction.amount.toLocaleString('id-ID')}</td>
                                        <td className="px-4 py-3">{getStatusBadge(transaction.status)}</td>
                                        <td className="px-4 py-3 text-gray-400">{new Date(transaction.createdAt).toLocaleDateString('id-ID')}</td>
                                        <td className="px-4 py-3">
                                            <button
                                                onClick={() => setSelectedTransaction(transaction)}
                                                className="rounded-2xl bg-[#252540] border border-[#3a3a5a] p-2 text-orange-400 hover:bg-[#3a3a5a] transition-colors"
                                            >
                                                <Eye className="w-4 h-4" />
                                            </button>
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>

                <div className="flex items-center justify-between border-t border-[#3a3a5a] p-4 bg-[#252540]/30">
                    <p className="text-sm text-gray-500">Menampilkan {paginatedTransactions.length} dari {filteredTransactions.length} transaksi</p>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => setPage((current) => Math.max(1, current - 1))}
                            disabled={currentPage === 1}
                            className="flex items-center gap-1 rounded-2xl border border-[#3a3a5a] bg-[#252540] px-3 py-2 text-sm text-white disabled:opacity-50 hover:bg-[#3a3a5a] transition-colors"
                        >
                            <ChevronLeft className="w-4 h-4" /> Prev
                        </button>
                        <span className="text-sm text-gray-400">Hal {currentPage} / {totalPages}</span>
                        <button
                            onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                            disabled={currentPage >= totalPages}
                            className="flex items-center gap-1 rounded-2xl border border-[#3a3a5a] bg-[#252540] px-3 py-2 text-sm text-white disabled:opacity-50 hover:bg-[#3a3a5a] transition-colors"
                        >
                            Next <ChevronRight className="w-4 h-4" />
                        </button>
                    </div>
                </div>
            </div>

            {selectedTransaction && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                    <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setSelectedTransaction(null)} />
                    <div className="relative w-full max-w-lg overflow-hidden rounded-[28px] border border-[#3a3a5a] bg-[#1a1a2e] shadow-2xl">
                        <div className="flex items-center justify-between border-b border-[#3a3a5a] px-6 py-4 bg-[#252540]/60">
                            <div>
                                <p className="text-xs text-gray-500">Detail Transaksi</p>
                                <p className="text-lg font-semibold text-white">{selectedTransaction.product?.name || '-'}</p>
                            </div>
                            <button onClick={() => setSelectedTransaction(null)} className="flex h-9 w-9 items-center justify-center rounded-full border border-[#3a3a5a] bg-[#252540] text-gray-400 hover:text-white transition-colors">
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        <div className="p-6 space-y-4">
                            <div className="grid grid-cols-2 gap-3">
                                <div className="rounded-[22px] border border-[#3a3a5a] bg-[#252540]/60 p-3">
                                    <p className="text-xs text-gray-500">Invoice</p>
                                    <p className="text-sm font-mono text-white">{selectedTransaction.invoiceNumber || selectedTransaction._id.slice(-8).toUpperCase()}</p>
                                </div>
                                <div className="rounded-[22px] border border-[#3a3a5a] bg-[#252540]/60 p-3">
                                    <p className="text-xs text-gray-500">Status Order</p>
                                    <div className="mt-1">{getStatusBadge(selectedTransaction.status)}</div>
                                </div>
                                <div className="rounded-[22px] border border-[#3a3a5a] bg-[#252540]/60 p-3">
                                    <p className="text-xs text-gray-500">Sumber</p>
                                    <div className="mt-1">{getSourceBadge(selectedTransaction)}</div>
                                </div>
                                <div className="rounded-[22px] border border-[#3a3a5a] bg-[#252540]/60 p-3">
                                    <p className="text-xs text-gray-500">Status Pembayaran</p>
                                    <div className="mt-1">{getPaymentStatusBadge(selectedTransaction.paymentStatus) || <span className="text-sm text-gray-400">Saldo internal</span>}</div>
                                </div>
                                <div className="col-span-2 rounded-[22px] border border-[#3a3a5a] bg-[#252540]/60 p-3">
                                    <p className="text-xs text-gray-500">Tujuan</p>
                                    <div className="flex items-center justify-between">
                                        <p className="text-sm text-white">{selectedTransaction.target}</p>
                                        <button onClick={() => copyToClipboard(selectedTransaction.target, 'target')} className="rounded-full p-2 bg-[#1a1a2e] hover:bg-[#3a3a5a] transition-colors">
                                            {copied === 'target' ? <CheckCircle className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4 text-gray-400" />}
                                        </button>
                                    </div>
                                </div>
                                <div className="rounded-[22px] border border-[#3a3a5a] bg-[#252540]/60 p-3">
                                    <p className="text-xs text-gray-500">Nominal</p>
                                    <p className="text-lg font-bold text-orange-400">Rp {selectedTransaction.amount.toLocaleString('id-ID')}</p>
                                </div>
                                <div className="rounded-[22px] border border-[#3a3a5a] bg-[#252540]/60 p-3">
                                    <p className="text-xs text-gray-500">Tanggal</p>
                                    <p className="text-sm text-white">{new Date(selectedTransaction.createdAt).toLocaleString('id-ID')}</p>
                                </div>
                                {selectedTransaction.sn && (
                                    <div className="col-span-2 rounded-[22px] border border-emerald-500/20 bg-emerald-500/10 p-4">
                                        <p className="text-xs text-emerald-400 font-semibold mb-1">SN / Token</p>
                                        <div className="flex items-center justify-between gap-3">
                                            <p className="break-all font-mono text-sm text-emerald-100">{selectedTransaction.sn}</p>
                                            <button onClick={() => copyToClipboard(selectedTransaction.sn!, 'sn')} className="shrink-0 rounded-full p-2 bg-[#1a1a2e] hover:bg-emerald-500/20 transition-colors">
                                                {copied === 'sn' ? <CheckCircle className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4 text-emerald-400" />}
                                            </button>
                                        </div>
                                    </div>
                                )}
                                {selectedTransaction.message && (
                                    <div className="col-span-2 rounded-[22px] border border-[#3a3a5a] bg-gradient-to-br from-[#1a1a2e] to-[#252540] p-4">
                                        <p className="text-xs font-semibold text-gray-400 mb-1">Pesan Sistem</p>
                                        <p className="text-sm text-white max-h-32 overflow-y-auto pr-2 custom-scrollbar">{selectedTransaction.message}</p>
                                    </div>
                                )}
                            </div>
                        </div>
                        <div className="px-6 py-4 border-t border-[#3a3a5a] bg-[#252540]/30 flex justify-end">
                            <button onClick={() => setSelectedTransaction(null)} className="px-5 py-2.5 bg-orange-500 hover:bg-orange-600 focus:ring-2 focus:ring-orange-500/50 text-white rounded-xl font-semibold transition-all">Tutup Detail</button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
