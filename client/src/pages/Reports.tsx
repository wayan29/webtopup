import { useEffect, useEffectEvent, useState } from 'react';
import { apiV2 } from '../api';
import {
    Activity,
    ChevronLeft,
    ChevronRight,
    FileSpreadsheet,
    FileText,
    Loader2,
    RefreshCw,
    ShoppingCart,
    Wallet
} from 'lucide-react';
import type { DashboardTransaction } from './dashboard/types';

interface ProductReport {
    productId: string;
    productName: string;
    productCode: string;
    totalTransactions: number;
    totalAmount: number;
    balanceAmount: number;
    gatewayAmount: number;
    successCount: number;
    failedCount: number;
    pendingCount: number;
}

export default function Reports() {
    const [transactions, setTransactions] = useState<DashboardTransaction[]>([]);
    const [reports, setReports] = useState<ProductReport[]>([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [filters, setFilters] = useState({
        startDate: new Date().toISOString().split('T')[0],
        endDate: new Date().toISOString().split('T')[0],
        source: '',
    });
    const [pagination, setPagination] = useState({
        page: 1,
        limit: 10,
        total: 0
    });

    const buildReports = (items: DashboardTransaction[], sourceFilter: string) => {
        const filteredTransactions = items.filter((transaction) => {
            if (filters.startDate && new Date(transaction.createdAt) < new Date(filters.startDate)) return false;
            if (filters.endDate) {
                const endDate = new Date(filters.endDate);
                endDate.setHours(23, 59, 59, 999);
                if (new Date(transaction.createdAt) > endDate) return false;
            }
            if (sourceFilter && (transaction.source || 'balance') !== sourceFilter) return false;
            return true;
        });

        const groupedByProduct: Record<string, DashboardTransaction[]> = {};
        filteredTransactions.forEach((transaction) => {
            const productKey = transaction.product?._id || transaction.product?.code || 'unknown';
            if (!groupedByProduct[productKey]) {
                groupedByProduct[productKey] = [];
            }
            groupedByProduct[productKey].push(transaction);
        });

        const productReports: ProductReport[] = Object.entries(groupedByProduct).map(([productId, groupedTransactions]) => {
            const successTransactions = groupedTransactions.filter((transaction) => transaction.status === 'success');
            const balanceSuccessTransactions = successTransactions.filter((transaction) => transaction.source !== 'payment_gateway');
            const gatewaySuccessTransactions = successTransactions.filter((transaction) => transaction.source === 'payment_gateway');

            return {
                productId,
                productName: groupedTransactions[0]?.product?.name || 'Produk Tidak Diketahui',
                productCode: groupedTransactions[0]?.product?.code || '-',
                totalTransactions: groupedTransactions.length,
                totalAmount: successTransactions.reduce((sum, transaction) => sum + transaction.amount, 0),
                balanceAmount: balanceSuccessTransactions.reduce((sum, transaction) => sum + transaction.amount, 0),
                gatewayAmount: gatewaySuccessTransactions.reduce((sum, transaction) => sum + transaction.amount, 0),
                successCount: successTransactions.length,
                failedCount: groupedTransactions.filter((transaction) => transaction.status === 'failed').length,
                pendingCount: groupedTransactions.filter((transaction) => transaction.status === 'pending' || transaction.status === 'processing').length,
            };
        });

        productReports.sort((a, b) => b.totalTransactions - a.totalTransactions);

        setReports(productReports);
        setPagination((current) => ({ ...current, total: productReports.length }));
    };

    const fetchReports = useEffectEvent(async (mode: 'initial' | 'refresh' = 'initial') => {
        if (mode === 'initial') {
            setLoading(true);
        } else {
            setRefreshing(true);
        }

        try {
            const response = await apiV2
                .get<DashboardTransaction[]>('/transactions');
            const items = Array.isArray(response.data) ? response.data : [];
            setTransactions(items);
            buildReports(items, filters.source);
            setError(null);
        } catch (fetchError) {
            console.error('Failed to fetch reports', fetchError);
            setError('Gagal memuat laporan transaksi.');
        } finally {
            if (mode === 'initial') {
                setLoading(false);
            } else {
                setRefreshing(false);
            }
        }
    });

    useEffect(() => {
        void fetchReports('initial');
    }, []);

    const handleFilter = () => {
        setPagination((current) => ({ ...current, page: 1 }));
        buildReports(transactions, filters.source);
    };

    const paginatedData = reports.slice(
        (pagination.page - 1) * pagination.limit,
        pagination.page * pagination.limit
    );

    const totalPages = Math.ceil(pagination.total / pagination.limit);

    const exportCSV = () => {
        const headers = ['Produk', 'Kode', 'Total Transaksi', 'Sukses', 'Pending', 'Gagal', 'Nilai Saldo', 'Nilai Gateway', 'Total Penjualan'];
        const rows = reports.map(r => [
            r.productName,
            r.productCode,
            r.totalTransactions,
            r.successCount,
            r.pendingCount,
            r.failedCount,
            r.balanceAmount,
            r.gatewayAmount,
            r.totalAmount
        ]);
        
        const csvContent = [headers, ...rows].map(row => row.join(',')).join('\n');
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `laporan_produk_${new Date().toISOString().split('T')[0]}.csv`;
        link.click();
    };

    const exportXLSX = () => {
        exportCSV();
        alert('File diunduh dalam format CSV. Untuk XLSX, silakan konversi manual atau gunakan Excel.');
    };

    // Calculate totals
    const totals = reports.reduce((acc, report) => ({
        totalTransactions: acc.totalTransactions + report.totalTransactions,
        totalAmount: acc.totalAmount + report.totalAmount,
        balanceAmount: acc.balanceAmount + report.balanceAmount,
        gatewayAmount: acc.gatewayAmount + report.gatewayAmount,
        successCount: acc.successCount + report.successCount,
        failedCount: acc.failedCount + report.failedCount,
        pendingCount: acc.pendingCount + report.pendingCount,
    }), { totalTransactions: 0, totalAmount: 0, balanceAmount: 0, gatewayAmount: 0, successCount: 0, failedCount: 0, pendingCount: 0 });

    const totalSuccessTransactions = transactions.filter((transaction) => transaction.status === 'success');
    const successRate = transactions.length > 0
        ? Math.round((totalSuccessTransactions.length / transactions.length) * 100)
        : 0;

    return (
        <div className="min-h-screen bg-[#1a1a1f] text-white p-4 md:p-6 space-y-6">
            <div className="relative overflow-hidden rounded-2xl border border-orange-500/20 bg-gradient-to-r from-[#1f1f35] via-[#1b1b2f] to-[#11111f] p-5 sm:p-6">
                <div className="absolute inset-0 pointer-events-none">
                    <div className="absolute inset-0 opacity-30 bg-[radial-gradient(circle_at_20%_20%,rgba(255,141,70,0.2),transparent_32%),radial-gradient(circle_at_80%_10%,rgba(109,152,255,0.22),transparent_30%)]" />
                </div>
                <div className="relative">
                    <h1 className="text-2xl font-bold text-white">Laporan</h1>
                    <p className="text-gray-400 mt-1">
                        Ringkasan produk dengan pemisahan nilai order via saldo internal dan payment gateway.
                    </p>
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="rounded-xl border border-white/5 bg-[#25252d] p-4">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg bg-orange-500/20 flex items-center justify-center">
                            <ShoppingCart className="w-5 h-5 text-orange-400" />
                        </div>
                        <div>
                            <p className="text-xs uppercase tracking-wide text-gray-500">Total Nilai Sukses</p>
                            <p className="mt-1 text-2xl font-bold text-white">Rp {totals.totalAmount.toLocaleString('id-ID')}</p>
                        </div>
                    </div>
                </div>
                <div className="rounded-xl border border-white/5 bg-[#25252d] p-4">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg bg-emerald-500/20 flex items-center justify-center">
                            <Wallet className="w-5 h-5 text-emerald-400" />
                        </div>
                        <div>
                            <p className="text-xs uppercase tracking-wide text-gray-500">Via Saldo</p>
                            <p className="mt-1 text-2xl font-bold text-emerald-400">Rp {totals.balanceAmount.toLocaleString('id-ID')}</p>
                        </div>
                    </div>
                </div>
                <div className="rounded-xl border border-white/5 bg-[#25252d] p-4">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg bg-sky-500/20 flex items-center justify-center">
                            <Activity className="w-5 h-5 text-sky-300" />
                        </div>
                        <div>
                            <p className="text-xs uppercase tracking-wide text-gray-500">Via Gateway</p>
                            <p className="mt-1 text-2xl font-bold text-sky-300">Rp {totals.gatewayAmount.toLocaleString('id-ID')}</p>
                        </div>
                    </div>
                </div>
                <div className="rounded-xl border border-white/5 bg-[#25252d] p-4">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg bg-blue-500/20 flex items-center justify-center">
                            <RefreshCw className="w-5 h-5 text-blue-400" />
                        </div>
                        <div>
                            <p className="text-xs uppercase tracking-wide text-gray-500">Tingkat Sukses</p>
                            <p className="mt-1 text-2xl font-bold text-white">{successRate}%</p>
                        </div>
                    </div>
                </div>
            </div>

            <div className="bg-[#25252d] rounded-xl p-4 space-y-4 border border-white/5">
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
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
                        <label className="block text-sm font-medium text-gray-400 mb-2">Sumber Pembayaran</label>
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

                    <div className="flex items-end gap-2">
                        <button
                            onClick={handleFilter}
                            className="flex-1 bg-orange-500 hover:bg-orange-600 text-white px-4 py-2.5 rounded-lg font-semibold text-sm transition-colors"
                        >
                            Cari
                        </button>
                        <button
                            onClick={() => void fetchReports('refresh')}
                            className="bg-[#1a1a1f] hover:bg-white/5 text-white px-4 py-2.5 rounded-lg font-semibold text-sm transition-colors border border-white/10 inline-flex items-center gap-2"
                        >
                            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
                            Refresh
                        </button>
                    </div>
                </div>

                <div className="flex gap-2">
                    <button
                        onClick={exportCSV}
                        className="bg-[#1a1a1f] hover:bg-white/5 text-white px-4 py-2.5 rounded-lg font-semibold text-sm transition-colors border border-white/10 flex items-center gap-2"
                    >
                        <FileText className="w-4 h-4" />
                        CSV
                    </button>
                    <button
                        onClick={exportXLSX}
                        className="bg-[#1a1a1f] hover:bg-white/5 text-white px-4 py-2.5 rounded-lg font-semibold text-sm transition-colors border border-white/10 flex items-center gap-2"
                    >
                        <FileSpreadsheet className="w-4 h-4" />
                        XLSX
                    </button>
                </div>
                {error && (
                    <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                        {error}
                    </div>
                )}
            </div>

            <div className="bg-[#25252d] rounded-xl overflow-hidden border border-white/5">
                <div className="p-4 border-b border-white/10 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <select
                            value={pagination.limit}
                            onChange={(event) => setPagination({ ...pagination, limit: Number(event.target.value), page: 1 })}
                            className="bg-[#1a1a1f] border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:border-orange-500 focus:outline-none"
                        >
                            <option value={10}>10 Entri</option>
                            <option value={25}>25 Entri</option>
                            <option value={50}>50 Entri</option>
                            <option value={100}>100 Entri</option>
                        </select>
                    </div>
                </div>

                <div className="overflow-x-auto">
                    <table className="min-w-full">
                        <thead>
                            <tr className="border-b border-white/10">
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400">Produk</th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400">Kode</th>
                                <th className="px-4 py-3 text-center text-xs font-medium text-gray-400">Total Trx</th>
                                <th className="px-4 py-3 text-center text-xs font-medium text-gray-400">Sukses</th>
                                <th className="px-4 py-3 text-center text-xs font-medium text-gray-400">Pending</th>
                                <th className="px-4 py-3 text-center text-xs font-medium text-gray-400">Gagal</th>
                                <th className="px-4 py-3 text-right text-xs font-medium text-gray-400">Saldo</th>
                                <th className="px-4 py-3 text-right text-xs font-medium text-gray-400">Gateway</th>
                                <th className="px-4 py-3 text-right text-xs font-medium text-gray-400">Total Penjualan</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-white/5">
                            {loading ? (
                                <tr>
                                    <td colSpan={9} className="px-4 py-12 text-center">
                                        <Loader2 className="w-8 h-8 animate-spin mx-auto mb-3 text-orange-500" />
                                        <p className="text-gray-400">Memuat data...</p>
                                    </td>
                                </tr>
                            ) : paginatedData.length === 0 ? (
                                <tr>
                                    <td colSpan={9} className="px-4 py-12 text-center">
                                        <div className="text-gray-500 mb-2">
                                            <svg className="w-16 h-16 mx-auto mb-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                            </svg>
                                        </div>
                                        <p className="text-white font-semibold mb-1">Data tidak ditemukan!</p>
                                        <p className="text-gray-400 text-sm">Tidak ada transaksi pada periode ini.</p>
                                    </td>
                                </tr>
                            ) : (
                                <>
                                    {paginatedData.map((report) => (
                                        <tr key={report.productId} className="hover:bg-white/5">
                                            <td className="px-4 py-3 text-sm text-white font-medium">
                                                {report.productName}
                                            </td>
                                            <td className="px-4 py-3 text-sm text-blue-400 font-mono">
                                                {report.productCode}
                                            </td>
                                            <td className="px-4 py-3 text-sm text-gray-300 text-center">
                                                {report.totalTransactions}
                                            </td>
                                            <td className="px-4 py-3 text-sm text-center">
                                                <span className="text-green-400 font-medium">{report.successCount}</span>
                                            </td>
                                            <td className="px-4 py-3 text-sm text-center">
                                                <span className="text-yellow-400 font-medium">{report.pendingCount}</span>
                                            </td>
                                            <td className="px-4 py-3 text-sm text-center">
                                                <span className="text-red-400 font-medium">{report.failedCount}</span>
                                            </td>
                                            <td className="px-4 py-3 text-sm text-right text-emerald-400 font-medium">
                                                Rp {report.balanceAmount.toLocaleString('id-ID')}
                                            </td>
                                            <td className="px-4 py-3 text-sm text-right text-sky-300 font-medium">
                                                Rp {report.gatewayAmount.toLocaleString('id-ID')}
                                            </td>
                                            <td className="px-4 py-3 text-sm text-white font-bold text-right">
                                                Rp {report.totalAmount.toLocaleString('id-ID')}
                                            </td>
                                        </tr>
                                    ))}
                                    {/* Total Row */}
                                    {paginatedData.length > 0 && (
                                        <tr className="bg-[#1a1a1f] border-t-2 border-orange-500">
                                            <td colSpan={2} className="px-4 py-3 text-sm text-orange-400 font-bold">
                                                TOTAL
                                            </td>
                                            <td className="px-4 py-3 text-sm text-orange-400 font-bold text-center">
                                                {totals.totalTransactions}
                                            </td>
                                            <td className="px-4 py-3 text-sm text-green-400 font-bold text-center">
                                                {totals.successCount}
                                            </td>
                                            <td className="px-4 py-3 text-sm text-yellow-400 font-bold text-center">
                                                {totals.pendingCount}
                                            </td>
                                            <td className="px-4 py-3 text-sm text-red-400 font-bold text-center">
                                                {totals.failedCount}
                                            </td>
                                            <td className="px-4 py-3 text-sm text-emerald-400 font-bold text-right">
                                                Rp {totals.balanceAmount.toLocaleString('id-ID')}
                                            </td>
                                            <td className="px-4 py-3 text-sm text-sky-300 font-bold text-right">
                                                Rp {totals.gatewayAmount.toLocaleString('id-ID')}
                                            </td>
                                            <td className="px-4 py-3 text-sm text-orange-400 font-bold text-right">
                                                Rp {totals.totalAmount.toLocaleString('id-ID')}
                                            </td>
                                        </tr>
                                    )}
                                </>
                            )}
                        </tbody>
                    </table>
                </div>

                <div className="p-4 border-t border-white/10 flex flex-col sm:flex-row items-center justify-between gap-4">
                    <p className="text-sm text-gray-400">
                        Menampilkan {paginatedData.length > 0 ? ((pagination.page - 1) * pagination.limit) + 1 : 0} sampai {Math.min(pagination.page * pagination.limit, pagination.total)} dari {pagination.total} hasil
                    </p>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => setPagination({ ...pagination, page: pagination.page - 1 })}
                            disabled={pagination.page === 1}
                            className="px-4 py-2 bg-[#1a1a1f] border border-white/10 rounded-lg text-sm text-gray-400 hover:text-white hover:border-orange-500 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                        >
                            <ChevronLeft className="w-4 h-4" />
                            Sebelumnya
                        </button>
                        <button
                            onClick={() => setPagination({ ...pagination, page: pagination.page + 1 })}
                            disabled={pagination.page >= totalPages}
                            className="px-4 py-2 bg-[#1a1a1f] border border-white/10 rounded-lg text-sm text-gray-400 hover:text-white hover:border-orange-500 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                        >
                            Selanjutnya
                            <ChevronRight className="w-4 h-4" />
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
