import { useEffect, useEffectEvent, useState } from 'react';
import { apiV2 } from '../api';
import {
    CheckCircle,
    ChevronLeft,
    ChevronRight,
    Clock,
    Copy,
    Eye,
    FileSpreadsheet,
    FileText,
    Loader2,
    RefreshCw,
    Search,
    X,
    XCircle
} from 'lucide-react';
import type { DashboardTransaction } from './dashboard/types';

const getOrderStatusBadge = (status: string, size: 'sm' | 'md' = 'sm') => {
    const baseClass = size === 'md'
        ? 'px-3 py-1.5 text-sm font-semibold rounded-full'
        : 'px-2 py-1 text-xs font-semibold rounded-full';

    switch (status) {
        case 'success':
            return <span className={`${baseClass} bg-green-500/20 text-green-400`}>Sukses</span>;
        case 'pending':
            return <span className={`${baseClass} bg-yellow-500/20 text-yellow-400`}>Menunggu</span>;
        case 'processing':
            return <span className={`${baseClass} bg-blue-500/20 text-blue-400`}>Proses</span>;
        case 'failed':
            return <span className={`${baseClass} bg-red-500/20 text-red-400`}>Gagal</span>;
        default:
            return <span className={`${baseClass} bg-gray-500/20 text-gray-400`}>{status}</span>;
    }
};

const getPaymentStatusBadge = (paymentStatus?: string) => {
    switch (paymentStatus) {
        case 'paid':
            return <span className="px-2 py-1 text-xs font-semibold rounded-full bg-emerald-500/20 text-emerald-300">Pembayaran Masuk</span>;
        case 'waiting_payment':
            return <span className="px-2 py-1 text-xs font-semibold rounded-full bg-amber-500/20 text-amber-300">Menunggu Bayar</span>;
        case 'expired':
            return <span className="px-2 py-1 text-xs font-semibold rounded-full bg-rose-500/20 text-rose-300">Kadaluarsa</span>;
        case 'cancelled':
            return <span className="px-2 py-1 text-xs font-semibold rounded-full bg-slate-500/20 text-slate-300">Dibatalkan</span>;
        default:
            return <span className="px-2 py-1 text-xs font-semibold rounded-full bg-orange-500/20 text-orange-300">Saldo Internal</span>;
    }
};

const getSourceBadge = (source?: string) => (
    source === 'payment_gateway'
        ? <span className="px-2 py-1 text-xs font-semibold rounded-full bg-sky-500/20 text-sky-300">Gateway</span>
        : <span className="px-2 py-1 text-xs font-semibold rounded-full bg-orange-500/20 text-orange-300">Saldo</span>
);

const getStatusIcon = (status: string) => {
    switch (status) {
        case 'success':
            return <CheckCircle className="w-12 h-12 text-green-400" />;
        case 'pending':
            return <Clock className="w-12 h-12 text-yellow-400" />;
        case 'processing':
            return <RefreshCw className="w-12 h-12 text-blue-400 animate-spin" />;
        case 'failed':
            return <XCircle className="w-12 h-12 text-red-400" />;
        default:
            return <Clock className="w-12 h-12 text-gray-400" />;
    }
};

export default function Transactions() {
    const [allTransactions, setAllTransactions] = useState<DashboardTransaction[]>([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [selectedTransaction, setSelectedTransaction] = useState<DashboardTransaction | null>(null);
    const [copied, setCopied] = useState<string | null>(null);
    const [filters, setFilters] = useState({
        status: '',
        paymentStatus: '',
        source: '',
        startDate: '',
        endDate: '',
        search: ''
    });
    const [pagination, setPagination] = useState({
        page: 1,
        limit: 10
    });

    const loadTransactions = useEffectEvent(async (mode: 'initial' | 'refresh' = 'initial') => {
        if (mode === 'initial') {
            setLoading(true);
        } else {
            setRefreshing(true);
        }

        try {
            const response = await apiV2
                .get<DashboardTransaction[]>('/transactions');
            setAllTransactions(Array.isArray(response.data) ? response.data : []);
            setError(null);
        } catch (fetchError: any) {
            console.error('Failed to fetch transactions', fetchError);
            setError(fetchError.response?.data?.message || 'Gagal memuat transaksi.');
        } finally {
            if (mode === 'initial') {
                setLoading(false);
            } else {
                setRefreshing(false);
            }
        }
    });

    useEffect(() => {
        void loadTransactions('initial');
    }, []);

    const copyToClipboard = (text: string, field: string) => {
        navigator.clipboard.writeText(text);
        setCopied(field);
        window.setTimeout(() => setCopied(null), 2000);
    };

    const filteredTransactions = allTransactions.filter((transaction) => {
        if (filters.status && transaction.status !== filters.status) return false;
        if (filters.source && (transaction.source || 'balance') !== filters.source) return false;
        if (filters.paymentStatus) {
            if (filters.paymentStatus === 'internal' && transaction.source === 'payment_gateway') return false;
            if (filters.paymentStatus !== 'internal' && transaction.paymentStatus !== filters.paymentStatus) return false;
        }
        if (filters.search) {
            const search = filters.search.toLowerCase();
            const haystack = [
                transaction._id,
                transaction.invoiceNumber,
                transaction.vendorTrxId,
                transaction.target,
                transaction.product?.name,
                transaction.product?.code
            ]
                .filter(Boolean)
                .join(' ')
                .toLowerCase();

            if (!haystack.includes(search)) return false;
        }
        if (filters.startDate && new Date(transaction.createdAt) < new Date(filters.startDate)) return false;
        if (filters.endDate) {
            const endDate = new Date(filters.endDate);
            endDate.setHours(23, 59, 59, 999);
            if (new Date(transaction.createdAt) > endDate) return false;
        }
        return true;
    });

    const totalPages = Math.max(1, Math.ceil(filteredTransactions.length / pagination.limit));
    const currentPage = Math.min(pagination.page, totalPages);
    const paginatedTransactions = filteredTransactions.slice(
        (currentPage - 1) * pagination.limit,
        currentPage * pagination.limit
    );

    const exportCSV = () => {
        const headers = ['Invoice', 'Sumber', 'Status Pembayaran', 'Produk', 'Tujuan', 'Nominal', 'Status Order', 'Tanggal'];
        const rows = filteredTransactions.map((transaction) => [
            transaction.invoiceNumber || transaction._id.slice(-8).toUpperCase(),
            transaction.source === 'payment_gateway' ? 'Gateway' : 'Saldo',
            transaction.paymentStatus || 'internal',
            transaction.product?.name || '-',
            transaction.target,
            transaction.amount,
            transaction.status,
            new Date(transaction.createdAt).toLocaleString('id-ID')
        ]);

        const csvContent = [headers, ...rows].map((row) => row.join(',')).join('\n');
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `transaksi_member_${new Date().toISOString().split('T')[0]}.csv`;
        link.click();
    };

    const exportXLSX = () => {
        exportCSV();
        alert('File diunduh dalam format CSV. Untuk XLSX, silakan konversi manual atau gunakan Excel.');
    };

    const totalSuccessAmount = filteredTransactions
        .filter((transaction) => transaction.status === 'success')
        .reduce((sum, transaction) => sum + transaction.amount, 0);

    return (
        <div className="min-h-screen bg-[#1a1a1f] text-white p-4 md:p-6 space-y-6">
            <div className="relative overflow-hidden rounded-2xl border border-orange-500/20 bg-gradient-to-r from-[#1f1f35] via-[#1b1b2f] to-[#11111f] p-5 sm:p-6">
                <div className="absolute inset-0 pointer-events-none">
                    <div className="absolute inset-0 opacity-30 bg-[radial-gradient(circle_at_20%_20%,rgba(255,141,70,0.2),transparent_32%),radial-gradient(circle_at_80%_10%,rgba(109,152,255,0.22),transparent_30%)]" />
                </div>
                <div className="relative">
                    <h1 className="text-2xl font-bold text-white">Riwayat Transaksi</h1>
                    <p className="text-gray-400 mt-1">
                        Timeline order member dengan penanda sumber transaksi dan status pembayaran yang jelas.
                    </p>
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="rounded-xl border border-white/5 bg-[#25252d] p-4">
                    <p className="text-xs uppercase tracking-wide text-gray-500">Total Hasil Filter</p>
                    <p className="mt-2 text-3xl font-bold text-white">{filteredTransactions.length}</p>
                </div>
                <div className="rounded-xl border border-white/5 bg-[#25252d] p-4">
                    <p className="text-xs uppercase tracking-wide text-gray-500">Order Sukses</p>
                    <p className="mt-2 text-3xl font-bold text-emerald-400">
                        {filteredTransactions.filter((transaction) => transaction.status === 'success').length}
                    </p>
                </div>
                <div className="rounded-xl border border-white/5 bg-[#25252d] p-4">
                    <p className="text-xs uppercase tracking-wide text-gray-500">Nilai Sukses</p>
                    <p className="mt-2 text-3xl font-bold text-orange-400">Rp {totalSuccessAmount.toLocaleString('id-ID')}</p>
                </div>
            </div>

            <div className="bg-[#25252d] rounded-xl p-4 space-y-4 border border-white/5">
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    <div>
                        <label className="block text-sm font-medium text-gray-400 mb-2">Status Order</label>
                        <select
                            value={filters.status}
                            onChange={(event) => setFilters({ ...filters, status: event.target.value })}
                            className="w-full bg-[#1a1a1f] border border-white/10 rounded-lg px-3 py-2.5 text-white text-sm focus:border-orange-500 focus:outline-none"
                        >
                            <option value="">Semua</option>
                            <option value="pending">Menunggu</option>
                            <option value="processing">Proses</option>
                            <option value="success">Sukses</option>
                            <option value="failed">Gagal</option>
                        </select>
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-400 mb-2">Sumber</label>
                        <select
                            value={filters.source}
                            onChange={(event) => setFilters({ ...filters, source: event.target.value })}
                            className="w-full bg-[#1a1a1f] border border-white/10 rounded-lg px-3 py-2.5 text-white text-sm focus:border-orange-500 focus:outline-none"
                        >
                            <option value="">Semua</option>
                            <option value="balance">Saldo</option>
                            <option value="payment_gateway">Gateway</option>
                        </select>
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-400 mb-2">Status Pembayaran</label>
                        <select
                            value={filters.paymentStatus}
                            onChange={(event) => setFilters({ ...filters, paymentStatus: event.target.value })}
                            className="w-full bg-[#1a1a1f] border border-white/10 rounded-lg px-3 py-2.5 text-white text-sm focus:border-orange-500 focus:outline-none"
                        >
                            <option value="">Semua</option>
                            <option value="internal">Saldo Internal</option>
                            <option value="waiting_payment">Menunggu Bayar</option>
                            <option value="paid">Pembayaran Masuk</option>
                            <option value="expired">Kadaluarsa</option>
                            <option value="cancelled">Dibatalkan</option>
                        </select>
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-400 mb-2">Tanggal Mulai</label>
                        <input
                            type="date"
                            value={filters.startDate}
                            onChange={(event) => setFilters({ ...filters, startDate: event.target.value })}
                            className="w-full bg-[#1a1a1f] border border-white/10 rounded-lg px-3 py-2.5 text-white text-sm focus:border-orange-500 focus:outline-none"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-400 mb-2">Tanggal Akhir</label>
                        <input
                            type="date"
                            value={filters.endDate}
                            onChange={(event) => setFilters({ ...filters, endDate: event.target.value })}
                            className="w-full bg-[#1a1a1f] border border-white/10 rounded-lg px-3 py-2.5 text-white text-sm focus:border-orange-500 focus:outline-none"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-400 mb-2">Pencarian</label>
                        <div className="relative">
                            <input
                                type="text"
                                value={filters.search}
                                onChange={(event) => setFilters({ ...filters, search: event.target.value })}
                                placeholder="Invoice, target, produk, ref..."
                                className="w-full bg-[#1a1a1f] border border-white/10 rounded-lg px-3 py-2.5 text-white text-sm focus:border-orange-500 focus:outline-none pr-10"
                            />
                            <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                        </div>
                    </div>
                </div>

                <div className="flex flex-col md:flex-row gap-3 items-start md:items-end justify-between">
                    <div className="flex gap-2">
                        <button
                            onClick={() => {
                                setFilters({
                                    status: '',
                                    paymentStatus: '',
                                    source: '',
                                    startDate: '',
                                    endDate: '',
                                    search: ''
                                });
                                setPagination((current) => ({ ...current, page: 1 }));
                            }}
                            className="bg-[#1a1a1f] hover:bg-white/5 text-white px-4 py-2.5 rounded-lg font-semibold text-sm transition-colors border border-white/10"
                        >
                            Reset
                        </button>
                        <button
                            onClick={() => void loadTransactions('refresh')}
                            className="bg-[#1a1a1f] hover:bg-white/5 text-white px-4 py-2.5 rounded-lg font-semibold text-sm transition-colors border border-white/10 inline-flex items-center gap-2"
                        >
                            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
                            Refresh
                        </button>
                    </div>
                    <div className="flex gap-2 w-full md:w-auto">
                        <button
                            onClick={exportCSV}
                            className="flex-1 md:flex-none bg-[#1a1a1f] hover:bg-white/5 text-white px-4 py-2.5 rounded-lg font-semibold text-sm transition-colors border border-white/10 flex items-center justify-center gap-2"
                        >
                            <FileText className="w-4 h-4" />
                            CSV
                        </button>
                        <button
                            onClick={exportXLSX}
                            className="flex-1 md:flex-none bg-[#1a1a1f] hover:bg-white/5 text-white px-4 py-2.5 rounded-lg font-semibold text-sm transition-colors border border-white/10 flex items-center justify-center gap-2"
                        >
                            <FileSpreadsheet className="w-4 h-4" />
                            XLSX
                        </button>
                    </div>
                </div>
            </div>

            <div className="bg-[#25252d] rounded-xl overflow-hidden border border-white/5">
                <div className="p-4 border-b border-white/10 flex items-center justify-between">
                    <select
                        value={pagination.limit}
                        onChange={(event) => setPagination({ page: 1, limit: Number(event.target.value) })}
                        className="bg-[#1a1a1f] border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:border-orange-500 focus:outline-none"
                    >
                        <option value={10}>10 Entri</option>
                        <option value={25}>25 Entri</option>
                        <option value={50}>50 Entri</option>
                        <option value={100}>100 Entri</option>
                    </select>
                    {error && <p className="text-sm text-red-300">{error}</p>}
                </div>

                <div className="overflow-x-auto">
                    <table className="min-w-full">
                        <thead>
                            <tr className="border-b border-white/10">
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400">Invoice</th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400">Produk</th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400">Tujuan</th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400">Nominal</th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400">Tanggal</th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400">Status</th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400">Aksi</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-white/5">
                            {loading ? (
                                <tr>
                                    <td colSpan={7} className="px-4 py-12 text-center">
                                        <Loader2 className="w-8 h-8 animate-spin mx-auto mb-3 text-orange-500" />
                                        <p className="text-gray-400">Memuat data...</p>
                                    </td>
                                </tr>
                            ) : paginatedTransactions.length === 0 ? (
                                <tr>
                                    <td colSpan={7} className="px-4 py-12 text-center">
                                        <div className="text-gray-500 mb-2">
                                            <svg className="w-16 h-16 mx-auto mb-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                            </svg>
                                        </div>
                                        <p className="text-white font-semibold mb-1">Data tidak ditemukan</p>
                                        <p className="text-gray-400 text-sm">Tidak ada transaksi pada filter ini.</p>
                                    </td>
                                </tr>
                            ) : (
                                paginatedTransactions.map((transaction) => (
                                    <tr key={transaction._id} className="hover:bg-white/5">
                                        <td className="px-4 py-3 text-sm text-white">
                                            <div className="font-medium">{transaction.invoiceNumber || transaction._id.slice(-8).toUpperCase()}</div>
                                            <div className="mt-1 flex flex-wrap gap-1.5">
                                                {getSourceBadge(transaction.source)}
                                                {getPaymentStatusBadge(transaction.paymentStatus)}
                                            </div>
                                        </td>
                                        <td className="px-4 py-3 text-sm text-white">
                                            {transaction.product?.name || '-'}
                                        </td>
                                        <td className="px-4 py-3 text-sm text-gray-300">
                                            {transaction.target}
                                        </td>
                                        <td className="px-4 py-3 text-sm text-white font-medium">
                                            Rp {transaction.amount.toLocaleString('id-ID')}
                                        </td>
                                        <td className="px-4 py-3 text-sm text-gray-400">
                                            {new Date(transaction.createdAt).toLocaleString('id-ID')}
                                        </td>
                                        <td className="px-4 py-3">
                                            {getOrderStatusBadge(transaction.status)}
                                        </td>
                                        <td className="px-4 py-3">
                                            <button
                                                onClick={() => setSelectedTransaction(transaction)}
                                                className="p-2 bg-orange-500/20 hover:bg-orange-500/30 text-orange-400 rounded-lg transition-colors"
                                                title="Lihat Detail"
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

                <div className="p-4 border-t border-white/10 flex flex-col sm:flex-row items-center justify-between gap-4">
                    <p className="text-sm text-gray-400">
                        Menampilkan {paginatedTransactions.length > 0 ? ((currentPage - 1) * pagination.limit) + 1 : 0} sampai {Math.min(currentPage * pagination.limit, filteredTransactions.length)} dari {filteredTransactions.length} hasil
                    </p>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => setPagination((current) => ({ ...current, page: Math.max(1, current.page - 1) }))}
                            disabled={currentPage === 1}
                            className="px-4 py-2 bg-[#1a1a1f] border border-white/10 rounded-lg text-sm text-gray-400 hover:text-white hover:border-orange-500 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                        >
                            <ChevronLeft className="w-4 h-4" />
                            Sebelumnya
                        </button>
                        <button
                            onClick={() => setPagination((current) => ({ ...current, page: Math.min(totalPages, current.page + 1) }))}
                            disabled={currentPage >= totalPages}
                            className="px-4 py-2 bg-[#1a1a1f] border border-white/10 rounded-lg text-sm text-gray-400 hover:text-white hover:border-orange-500 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                        >
                            Selanjutnya
                            <ChevronRight className="w-4 h-4" />
                        </button>
                    </div>
                </div>
            </div>

            {selectedTransaction && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                    <div
                        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
                        onClick={() => setSelectedTransaction(null)}
                    />
                    <div className="relative bg-[#25252d] w-full max-w-lg rounded-2xl border border-white/10 overflow-hidden">
                        <div className="px-6 py-4 border-b border-white/10 flex items-center justify-between">
                            <h3 className="text-lg font-semibold text-white">Detail Transaksi</h3>
                            <button
                                onClick={() => setSelectedTransaction(null)}
                                className="w-8 h-8 rounded-full bg-[#1a1a1f] flex items-center justify-center text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        <div className="p-6 space-y-6">
                            <div className="text-center">
                                {getStatusIcon(selectedTransaction.status)}
                                <div className="mt-3">
                                    {getOrderStatusBadge(selectedTransaction.status, 'md')}
                                </div>
                            </div>

                            <div className="space-y-4">
                                <div className="grid grid-cols-2 gap-3">
                                    <div className="p-3 bg-[#1a1a1f] rounded-lg border border-white/5">
                                        <p className="text-xs text-gray-500">Sumber</p>
                                        <div className="mt-1">{getSourceBadge(selectedTransaction.source)}</div>
                                    </div>
                                    <div className="p-3 bg-[#1a1a1f] rounded-lg border border-white/5">
                                        <p className="text-xs text-gray-500">Status Pembayaran</p>
                                        <div className="mt-1">{getPaymentStatusBadge(selectedTransaction.paymentStatus)}</div>
                                    </div>
                                </div>

                                <div className="flex items-center justify-between p-3 bg-[#1a1a1f] rounded-lg border border-white/5">
                                    <div>
                                        <p className="text-xs text-gray-500">Invoice</p>
                                        <p className="text-sm text-white font-mono">{selectedTransaction.invoiceNumber || selectedTransaction._id}</p>
                                    </div>
                                    <button
                                        onClick={() => copyToClipboard(selectedTransaction.invoiceNumber || selectedTransaction._id, 'invoice')}
                                        className="p-2 hover:bg-white/10 rounded-lg transition-colors"
                                    >
                                        {copied === 'invoice' ? <CheckCircle className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4 text-gray-400" />}
                                    </button>
                                </div>

                                {selectedTransaction.vendorTrxId && (
                                    <div className="flex items-center justify-between p-3 bg-[#1a1a1f] rounded-lg border border-white/5">
                                        <div>
                                            <p className="text-xs text-gray-500">Ref Vendor</p>
                                            <p className="text-sm text-white font-mono">{selectedTransaction.vendorTrxId}</p>
                                        </div>
                                        <button
                                            onClick={() => copyToClipboard(selectedTransaction.vendorTrxId!, 'vendor')}
                                            className="p-2 hover:bg-white/10 rounded-lg transition-colors"
                                        >
                                            {copied === 'vendor' ? <CheckCircle className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4 text-gray-400" />}
                                        </button>
                                    </div>
                                )}

                                <div className="p-3 bg-[#1a1a1f] rounded-lg border border-white/5">
                                    <p className="text-xs text-gray-500">Produk</p>
                                    <p className="text-sm text-white font-medium">{selectedTransaction.product?.name || '-'}</p>
                                    <p className="text-xs text-gray-400">{selectedTransaction.product?.code || '-'}</p>
                                </div>

                                <div className="flex items-center justify-between p-3 bg-[#1a1a1f] rounded-lg border border-white/5">
                                    <div>
                                        <p className="text-xs text-gray-500">Nomor Tujuan</p>
                                        <p className="text-sm text-white">{selectedTransaction.target}</p>
                                    </div>
                                    <button
                                        onClick={() => copyToClipboard(selectedTransaction.target, 'target')}
                                        className="p-2 hover:bg-white/10 rounded-lg transition-colors"
                                    >
                                        {copied === 'target' ? <CheckCircle className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4 text-gray-400" />}
                                    </button>
                                </div>

                                {selectedTransaction.sn && (
                                    <div className="flex items-center justify-between p-3 bg-green-500/10 border border-green-500/30 rounded-lg">
                                        <div>
                                            <p className="text-xs text-green-400">SN / Token</p>
                                            <p className="text-sm text-white font-mono break-all">{selectedTransaction.sn}</p>
                                        </div>
                                        <button
                                            onClick={() => copyToClipboard(selectedTransaction.sn!, 'sn')}
                                            className="p-2 hover:bg-green-500/20 rounded-lg transition-colors"
                                        >
                                            {copied === 'sn' ? <CheckCircle className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4 text-green-400" />}
                                        </button>
                                    </div>
                                )}

                                {selectedTransaction.message && (
                                    <div className="p-3 bg-[#1a1a1f] rounded-lg border border-white/5">
                                        <p className="text-xs text-gray-500">Pesan</p>
                                        <p className="text-sm text-white">{selectedTransaction.message}</p>
                                    </div>
                                )}

                                <div className="p-3 bg-[#1a1a1f] rounded-lg border border-white/5">
                                    <p className="text-xs text-gray-500">Total Harga</p>
                                    <p className="text-xl text-orange-400 font-bold">
                                        Rp {selectedTransaction.amount.toLocaleString('id-ID')}
                                    </p>
                                </div>

                                <div className="grid grid-cols-2 gap-3">
                                    <div className="p-3 bg-[#1a1a1f] rounded-lg border border-white/5">
                                        <p className="text-xs text-gray-500">Dibuat</p>
                                        <p className="text-sm text-white">
                                            {new Date(selectedTransaction.createdAt).toLocaleString('id-ID')}
                                        </p>
                                    </div>
                                    <div className="p-3 bg-[#1a1a1f] rounded-lg border border-white/5">
                                        <p className="text-xs text-gray-500">Diperbarui</p>
                                        <p className="text-sm text-white">
                                            {selectedTransaction.updatedAt ? new Date(selectedTransaction.updatedAt).toLocaleString('id-ID') : '-'}
                                        </p>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div className="px-6 py-4 border-t border-white/10">
                            <button
                                onClick={() => setSelectedTransaction(null)}
                                className="w-full py-3 bg-orange-500 hover:bg-orange-600 text-white font-semibold rounded-xl transition-colors"
                            >
                                Tutup
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
