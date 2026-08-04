import { useEffect, useEffectEvent, useState } from 'react';
import { apiV2 } from '../api';
import {
    ArrowDownLeft,
    ArrowUpRight,
    ChevronLeft,
    ChevronRight,
    Eye,
    FileSpreadsheet,
    FileText,
    Loader2,
    RefreshCw,
    Search,
    X
} from 'lucide-react';
import type { DashboardBalanceHistoryItem } from './dashboard/types';
import type { DashboardDeposit, DashboardTransaction } from './dashboard/types';
import { buildLegacyBalanceHistory } from '../utils/balanceHistory';

const sourceLabels: Record<DashboardBalanceHistoryItem['source'], string> = {
    deposit: 'Deposit',
    purchase: 'Pembelian Saldo',
    voucher: 'Redeem Voucher',
    adjustment: 'Penyesuaian Admin'
};

export default function Mutations() {
    const [mutations, setMutations] = useState<DashboardBalanceHistoryItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [selectedMutation, setSelectedMutation] = useState<DashboardBalanceHistoryItem | null>(null);
    const [filters, setFilters] = useState({
        type: '',
        source: '',
        startDate: '',
        endDate: '',
        search: ''
    });
    const [pagination, setPagination] = useState({
        page: 1,
        limit: 10
    });

    const loadMutations = useEffectEvent(async (mode: 'initial' | 'refresh' = 'initial') => {
        if (mode === 'initial') {
            setLoading(true);
        } else {
            setRefreshing(true);
        }

        try {
            const response = await apiV2
                .get<DashboardBalanceHistoryItem[] | { items?: DashboardBalanceHistoryItem[] }>('/users/me/balance-history');
            const payload = Array.isArray(response.data) ? response.data : response.data?.items;
            setMutations(Array.isArray(payload) ? payload : []);
            setError(null);
        } catch (fetchError: any) {
            if (fetchError.response?.status === 404) {
                try {
                    const [transactionsResponse, depositsResponse] = await Promise.all([
                        apiV2.get<DashboardTransaction[]>('/transactions'),
                        apiV2.get<DashboardDeposit[]>('/deposits')
                    ]);
                    const transactionItems = Array.isArray(transactionsResponse.data) ? transactionsResponse.data : [];
                    const depositItems = Array.isArray(depositsResponse.data) ? depositsResponse.data : [];
                    setMutations(buildLegacyBalanceHistory(transactionItems, depositItems));
                    setError('Riwayat saldo detail belum aktif di server. Halaman ini memakai fallback sementara.');
                } catch (fallbackError: any) {
                    console.error('Failed to fetch legacy balance history', fallbackError);
                    setError(fallbackError.response?.data?.message || 'Gagal memuat mutasi saldo.');
                }
            } else {
                console.error('Failed to fetch balance history', fetchError);
                setError(fetchError.response?.data?.message || 'Gagal memuat mutasi saldo.');
            }
        } finally {
            if (mode === 'initial') {
                setLoading(false);
            } else {
                setRefreshing(false);
            }
        }
    });

    useEffect(() => {
        void loadMutations('initial');
    }, []);

    const filteredMutations = mutations.filter((item) => {
        if (filters.type && item.type !== filters.type) return false;
        if (filters.source && item.source !== filters.source) return false;
        if (filters.search) {
            const search = filters.search.toLowerCase();
            const haystack = [
                item.description,
                item.reference,
                sourceLabels[item.source]
            ]
                .filter(Boolean)
                .join(' ')
                .toLowerCase();

            if (!haystack.includes(search)) return false;
        }
        if (filters.startDate && new Date(item.createdAt) < new Date(filters.startDate)) return false;
        if (filters.endDate) {
            const endDate = new Date(filters.endDate);
            endDate.setHours(23, 59, 59, 999);
            if (new Date(item.createdAt) > endDate) return false;
        }
        return true;
    });

    const totalPages = Math.max(1, Math.ceil(filteredMutations.length / pagination.limit));
    const currentPage = Math.min(pagination.page, totalPages);
    const paginatedMutations = filteredMutations.slice(
        (currentPage - 1) * pagination.limit,
        currentPage * pagination.limit
    );

    const totalCredit = filteredMutations
        .filter((item) => item.type === 'credit')
        .reduce((sum, item) => sum + item.amount, 0);

    const totalDebit = filteredMutations
        .filter((item) => item.type === 'debit')
        .reduce((sum, item) => sum + item.amount, 0);

    const exportCSV = () => {
        const headers = ['Tanggal', 'Sumber', 'Keterangan', 'Referensi', 'Tipe', 'Jumlah'];
        const rows = filteredMutations.map((item) => [
            new Date(item.createdAt).toLocaleString('id-ID'),
            sourceLabels[item.source],
            item.description,
            item.reference,
            item.type === 'credit' ? 'Masuk' : 'Keluar',
            item.type === 'credit' ? `+${item.amount}` : `-${item.amount}`
        ]);

        const csvContent = [headers, ...rows].map((row) => row.join(',')).join('\n');
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `mutasi_saldo_${new Date().toISOString().split('T')[0]}.csv`;
        link.click();
    };

    const exportXLSX = () => {
        exportCSV();
        alert('File diunduh dalam format CSV. Untuk XLSX, silakan konversi manual atau gunakan Excel.');
    };

    return (
        <div className="min-h-screen bg-[#1a1a1f] text-white p-4 md:p-6 space-y-6">
            <div className="relative overflow-hidden rounded-2xl border border-orange-500/20 bg-gradient-to-r from-[#1f1f35] via-[#1b1b2f] to-[#11111f] p-5 sm:p-6">
                <div className="absolute inset-0 pointer-events-none">
                    <div className="absolute inset-0 opacity-30 bg-[radial-gradient(circle_at_20%_20%,rgba(255,141,70,0.2),transparent_32%),radial-gradient(circle_at_80%_10%,rgba(109,152,255,0.22),transparent_30%)]" />
                </div>
                <div className="relative">
                    <h1 className="text-2xl font-bold text-white">Riwayat Mutasi</h1>
                    <p className="text-gray-400 mt-1">
                        Ledger saldo yang menampilkan deposit, pembelian via saldo, voucher, dan penyesuaian admin.
                    </p>
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="rounded-xl border border-white/5 bg-[#25252d] p-4">
                    <p className="text-xs uppercase tracking-wide text-gray-500">Total Entri</p>
                    <p className="mt-2 text-3xl font-bold text-white">{filteredMutations.length}</p>
                </div>
                <div className="rounded-xl border border-white/5 bg-[#25252d] p-4">
                    <p className="text-xs uppercase tracking-wide text-gray-500">Saldo Masuk</p>
                    <p className="mt-2 text-3xl font-bold text-green-400">Rp {totalCredit.toLocaleString('id-ID')}</p>
                </div>
                <div className="rounded-xl border border-white/5 bg-[#25252d] p-4">
                    <p className="text-xs uppercase tracking-wide text-gray-500">Saldo Keluar</p>
                    <p className="mt-2 text-3xl font-bold text-red-400">Rp {totalDebit.toLocaleString('id-ID')}</p>
                </div>
            </div>

            <div className="bg-[#25252d] rounded-xl p-4 space-y-4 border border-white/5">
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
                    <div>
                        <label className="block text-sm font-medium text-gray-400 mb-2">Tipe</label>
                        <select
                            value={filters.type}
                            onChange={(event) => {
                                setFilters((current) => ({ ...current, type: event.target.value }));
                                setPagination((current) => ({ ...current, page: 1 }));
                            }}
                            className="w-full bg-[#1a1a1f] border border-white/10 rounded-lg px-3 py-2.5 text-white text-sm focus:border-orange-500 focus:outline-none"
                        >
                            <option value="">Semua</option>
                            <option value="credit">Masuk</option>
                            <option value="debit">Keluar</option>
                        </select>
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-400 mb-2">Sumber</label>
                        <select
                            value={filters.source}
                            onChange={(event) => {
                                setFilters((current) => ({ ...current, source: event.target.value }));
                                setPagination((current) => ({ ...current, page: 1 }));
                            }}
                            className="w-full bg-[#1a1a1f] border border-white/10 rounded-lg px-3 py-2.5 text-white text-sm focus:border-orange-500 focus:outline-none"
                        >
                            <option value="">Semua</option>
                            <option value="deposit">Deposit</option>
                            <option value="purchase">Pembelian Saldo</option>
                            <option value="voucher">Voucher</option>
                            <option value="adjustment">Adjustment</option>
                        </select>
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-400 mb-2">Tanggal Mulai</label>
                        <input
                            type="date"
                            value={filters.startDate}
                            onChange={(event) => {
                                setFilters((current) => ({ ...current, startDate: event.target.value }));
                                setPagination((current) => ({ ...current, page: 1 }));
                            }}
                            className="w-full bg-[#1a1a1f] border border-white/10 rounded-lg px-3 py-2.5 text-white text-sm focus:border-orange-500 focus:outline-none"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-400 mb-2">Tanggal Akhir</label>
                        <input
                            type="date"
                            value={filters.endDate}
                            onChange={(event) => {
                                setFilters((current) => ({ ...current, endDate: event.target.value }));
                                setPagination((current) => ({ ...current, page: 1 }));
                            }}
                            className="w-full bg-[#1a1a1f] border border-white/10 rounded-lg px-3 py-2.5 text-white text-sm focus:border-orange-500 focus:outline-none"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-400 mb-2">Pencarian</label>
                        <div className="relative">
                            <input
                                type="text"
                                value={filters.search}
                                onChange={(event) => {
                                    setFilters((current) => ({ ...current, search: event.target.value }));
                                    setPagination((current) => ({ ...current, page: 1 }));
                                }}
                                placeholder="Referensi, sumber, keterangan..."
                                className="w-full bg-[#1a1a1f] border border-white/10 rounded-lg px-3 py-2.5 pr-10 text-white text-sm focus:border-orange-500 focus:outline-none"
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
                                    type: '',
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
                            onClick={() => void loadMutations('refresh')}
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
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400">Tanggal</th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400">Keterangan</th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400">Sumber</th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400">Referensi</th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400">Tipe</th>
                                <th className="px-4 py-3 text-right text-xs font-medium text-gray-400">Jumlah</th>
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
                            ) : paginatedMutations.length === 0 ? (
                                <tr>
                                    <td colSpan={7} className="px-4 py-12 text-center">
                                        <p className="text-white font-semibold mb-1">Tidak ada mutasi</p>
                                        <p className="text-gray-400 text-sm">
                                            {error ? 'Ledger saldo belum tersedia.' : 'Tidak ada data pada filter ini.'}
                                        </p>
                                    </td>
                                </tr>
                            ) : (
                                paginatedMutations.map((item) => (
                                    <tr key={`${item.source}-${item._id}`} className="hover:bg-white/5">
                                        <td className="px-4 py-3 text-sm text-gray-300">
                                            {new Date(item.createdAt).toLocaleString('id-ID')}
                                        </td>
                                        <td className="px-4 py-3 text-sm text-white font-medium">
                                            {item.description}
                                        </td>
                                        <td className="px-4 py-3 text-sm text-gray-300">
                                            {sourceLabels[item.source]}
                                        </td>
                                        <td className="px-4 py-3 text-sm text-blue-400 font-mono">
                                            {item.reference}
                                        </td>
                                        <td className="px-4 py-3">
                                            {item.type === 'credit' ? (
                                                <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold rounded-full bg-green-500/20 text-green-400">
                                                    <ArrowDownLeft className="w-3 h-3" /> Masuk
                                                </span>
                                            ) : (
                                                <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold rounded-full bg-red-500/20 text-red-400">
                                                    <ArrowUpRight className="w-3 h-3" /> Keluar
                                                </span>
                                            )}
                                        </td>
                                        <td className={`px-4 py-3 text-right text-sm font-bold ${item.type === 'credit' ? 'text-green-400' : 'text-red-400'}`}>
                                            {item.type === 'credit' ? '+' : '-'}Rp {item.amount.toLocaleString('id-ID')}
                                        </td>
                                        <td className="px-4 py-3">
                                            <button
                                                onClick={() => setSelectedMutation(item)}
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
                        Menampilkan {paginatedMutations.length > 0 ? ((currentPage - 1) * pagination.limit) + 1 : 0} sampai {Math.min(currentPage * pagination.limit, filteredMutations.length)} dari {filteredMutations.length} hasil
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

            {selectedMutation && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                    <div
                        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
                        onClick={() => setSelectedMutation(null)}
                    />
                    <div className="relative bg-[#25252d] w-full max-w-lg rounded-2xl border border-white/10 overflow-hidden">
                        <div className="px-6 py-4 border-b border-white/10 flex items-center justify-between">
                            <div>
                                <p className="text-xs text-gray-500">Detail Mutasi</p>
                                <h3 className="text-lg font-semibold text-white">{selectedMutation.description}</h3>
                            </div>
                            <button
                                onClick={() => setSelectedMutation(null)}
                                className="w-8 h-8 rounded-full bg-[#1a1a1f] flex items-center justify-center text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        <div className="p-6 space-y-4">
                            <div className="grid grid-cols-2 gap-3">
                                <div className="p-3 bg-[#1a1a1f] rounded-lg border border-white/5">
                                    <p className="text-xs text-gray-500">Referensi</p>
                                    <p className="text-sm text-white font-mono break-all">{selectedMutation.reference}</p>
                                </div>
                                <div className="p-3 bg-[#1a1a1f] rounded-lg border border-white/5">
                                    <p className="text-xs text-gray-500">Sumber</p>
                                    <p className="text-sm text-white">{sourceLabels[selectedMutation.source]}</p>
                                </div>
                                <div className="p-3 bg-[#1a1a1f] rounded-lg border border-white/5">
                                    <p className="text-xs text-gray-500">Tipe</p>
                                    <div className="mt-1">
                                        {selectedMutation.type === 'credit' ? (
                                            <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold rounded-full bg-green-500/20 text-green-400">
                                                <ArrowDownLeft className="w-3 h-3" /> Masuk
                                            </span>
                                        ) : (
                                            <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold rounded-full bg-red-500/20 text-red-400">
                                                <ArrowUpRight className="w-3 h-3" /> Keluar
                                            </span>
                                        )}
                                    </div>
                                </div>
                                <div className="p-3 bg-[#1a1a1f] rounded-lg border border-white/5">
                                    <p className="text-xs text-gray-500">Tanggal</p>
                                    <p className="text-sm text-white">{new Date(selectedMutation.createdAt).toLocaleString('id-ID')}</p>
                                </div>
                                <div className="p-3 bg-[#1a1a1f] rounded-lg border border-white/5 col-span-2">
                                    <p className="text-xs text-gray-500">Jumlah</p>
                                    <p className={`text-xl font-bold ${selectedMutation.type === 'credit' ? 'text-green-400' : 'text-red-400'}`}>
                                        {selectedMutation.type === 'credit' ? '+' : '-'}Rp {selectedMutation.amount.toLocaleString('id-ID')}
                                    </p>
                                </div>
                                {(selectedMutation.balanceBefore !== undefined || selectedMutation.balanceAfter !== undefined) && (
                                    <>
                                        <div className="p-3 bg-[#1a1a1f] rounded-lg border border-white/5">
                                            <p className="text-xs text-gray-500">Saldo Sebelum</p>
                                            <p className="text-sm text-white">Rp {(selectedMutation.balanceBefore || 0).toLocaleString('id-ID')}</p>
                                        </div>
                                        <div className="p-3 bg-[#1a1a1f] rounded-lg border border-white/5">
                                            <p className="text-xs text-gray-500">Saldo Sesudah</p>
                                            <p className="text-sm text-white">Rp {(selectedMutation.balanceAfter || 0).toLocaleString('id-ID')}</p>
                                        </div>
                                    </>
                                )}
                                {Boolean(selectedMutation.meta?.adjustedBy) && (
                                    <div className="p-3 bg-[#1a1a1f] rounded-lg border border-white/5 col-span-2">
                                        <p className="text-xs text-gray-500">Diproses Oleh</p>
                                        <p className="text-sm text-white">{String(selectedMutation.meta?.adjustedBy)}</p>
                                    </div>
                                )}
                            </div>
                        </div>

                        <div className="px-6 py-4 border-t border-white/10">
                            <button
                                onClick={() => setSelectedMutation(null)}
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
