import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { ArrowDownLeft, ArrowUpRight, ChevronLeft, ChevronRight, Eye, FileText, Loader2, X } from 'lucide-react';
import type { DashboardBalanceHistoryItem, DashboardOutletContext } from './types';

const sourceLabels: Record<DashboardBalanceHistoryItem['source'], string> = {
    deposit: 'Deposit',
    purchase: 'Pembelian Saldo',
    voucher: 'Redeem Voucher',
    adjustment: 'Penyesuaian Admin'
};

export default function DashboardMutation() {
    const { balanceHistory, loading, error } = useOutletContext<DashboardOutletContext>();
    const [page, setPage] = useState(1);
    const [limit] = useState(10);
    const [filters, setFilters] = useState({ type: '', startDate: '', endDate: '' });
    const [selectedMutation, setSelectedMutation] = useState<DashboardBalanceHistoryItem | null>(null);

    const filteredMutations = balanceHistory.filter((item) => {
        if (filters.type && item.type !== filters.type) return false;
        if (filters.startDate && new Date(item.createdAt) < new Date(filters.startDate)) return false;
        if (filters.endDate) {
            const endDate = new Date(filters.endDate);
            endDate.setHours(23, 59, 59, 999);
            if (new Date(item.createdAt) > endDate) return false;
        }
        return true;
    });

    const totalPages = Math.max(1, Math.ceil(filteredMutations.length / limit));
    const currentPage = Math.min(page, totalPages);
    const paginatedMutations = filteredMutations.slice((currentPage - 1) * limit, currentPage * limit);

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

    const inputClass = 'w-full rounded-2xl border border-[#3a3a5a] bg-[#252540] px-3 py-2.5 text-sm text-white focus:border-orange-500 focus:outline-none transition-colors';

    return (
        <>
            <div className="rounded-[28px] border border-[#3a3a5a] bg-[#1a1a2e] p-5">
                <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-gray-500">Balance Ledger</p>
                <h1 className="mt-2 text-3xl font-black text-white">Riwayat Mutasi Saldo</h1>
                <p className="mt-2 text-sm leading-7 text-gray-400">Ledger saldo member yang mencakup deposit, pembelian via saldo, voucher, dan adjustment admin.</p>
            </div>

            <div className="rounded-[28px] border border-[#3a3a5a] bg-[#1a1a2e] p-4">
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4">
                    <select
                        value={filters.type}
                        onChange={(event) => {
                            setFilters({ ...filters, type: event.target.value });
                            setPage(1);
                        }}
                        className={inputClass}
                    >
                        <option value="">Semua Tipe</option>
                        <option value="credit">Masuk</option>
                        <option value="debit">Keluar</option>
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
                            setFilters({ type: '', startDate: '', endDate: '' });
                            setPage(1);
                        }}
                        className="rounded-2xl bg-[#252540] border border-[#3a3a5a] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#3a3a5a] transition-colors"
                    >
                        Reset
                    </button>
                </div>
                <button
                    onClick={exportCSV}
                    className="flex items-center gap-2 rounded-2xl bg-orange-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-orange-600 transition-colors shadow-lg shadow-orange-500/20"
                >
                    <FileText className="w-4 h-4" /> Export CSV
                </button>
            </div>

            <div className="overflow-hidden rounded-[28px] border border-[#3a3a5a] bg-[#1a1a2e]">
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-[#3a3a5a] bg-[#252540]/30">
                                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-[0.24em] text-gray-500">Tanggal</th>
                                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-[0.24em] text-gray-500">Keterangan</th>
                                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-[0.24em] text-gray-500">Sumber</th>
                                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-[0.24em] text-gray-500">Referensi</th>
                                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-[0.24em] text-gray-500">Tipe</th>
                                <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-[0.24em] text-gray-500">Jumlah</th>
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
                            ) : paginatedMutations.length === 0 ? (
                                <tr>
                                    <td colSpan={7} className="text-center py-8 text-gray-500">
                                        {error ? 'Ledger saldo belum tersedia' : 'Tidak ada mutasi'}
                                    </td>
                                </tr>
                            ) : (
                                paginatedMutations.map((item) => (
                                    <tr key={`${item.source}-${item._id}`} className="hover:bg-[#252540]/50 transition-colors">
                                        <td className="px-4 py-3 text-gray-400">{new Date(item.createdAt).toLocaleString('id-ID')}</td>
                                        <td className="px-4 py-3 font-medium text-white">{item.description}</td>
                                        <td className="px-4 py-3 text-gray-400">{sourceLabels[item.source]}</td>
                                        <td className="px-4 py-3 font-mono text-[#6b86a3]">{item.reference}</td>
                                        <td className="px-4 py-3">
                                            {item.type === 'credit' ? (
                                                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/20 border border-emerald-500/30 px-2.5 py-1 text-[11px] font-semibold text-emerald-400">
                                                    <ArrowDownLeft className="w-3 h-3" /> Masuk
                                                </span>
                                            ) : (
                                                <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/20 border border-rose-500/30 px-2.5 py-1 text-[11px] font-semibold text-rose-400">
                                                    <ArrowUpRight className="w-3 h-3" /> Keluar
                                                </span>
                                            )}
                                        </td>
                                        <td className={`px-4 py-3 text-right font-bold ${item.type === 'credit' ? 'text-emerald-400' : 'text-rose-400'}`}>
                                            {item.type === 'credit' ? '+' : '-'}Rp {item.amount.toLocaleString('id-ID')}
                                        </td>
                                        <td className="px-4 py-3">
                                            <button
                                                onClick={() => setSelectedMutation(item)}
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
                    <p className="text-sm text-gray-500">Menampilkan {paginatedMutations.length} dari {filteredMutations.length} mutasi</p>
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

            {selectedMutation && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                    <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setSelectedMutation(null)} />
                    <div className="relative w-full max-w-lg overflow-hidden rounded-[28px] border border-[#3a3a5a] bg-[#1a1a2e] shadow-2xl">
                        <div className="flex items-center justify-between border-b border-[#3a3a5a] px-6 py-4 bg-[#252540]/60">
                            <div>
                                <p className="text-xs text-gray-500">Detail Mutasi</p>
                                <p className="text-lg font-semibold text-white">{selectedMutation.description}</p>
                            </div>
                            <button onClick={() => setSelectedMutation(null)} className="flex h-9 w-9 items-center justify-center rounded-full border border-[#3a3a5a] bg-[#252540] text-gray-400 hover:text-white transition-colors">
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        <div className="p-6 space-y-4">
                            <div className="grid grid-cols-2 gap-3">
                                <div className="rounded-[22px] border border-[#3a3a5a] bg-[#252540]/60 p-3">
                                    <p className="text-xs text-gray-500">Referensi</p>
                                    <p className="text-sm font-mono text-white">{selectedMutation.reference}</p>
                                </div>
                                <div className="rounded-[22px] border border-[#3a3a5a] bg-[#252540]/60 p-3">
                                    <p className="text-xs text-gray-500">Sumber</p>
                                    <p className="text-sm text-white">{sourceLabels[selectedMutation.source]}</p>
                                </div>
                                <div className="rounded-[22px] border border-[#3a3a5a] bg-[#252540]/60 p-3">
                                    <p className="text-xs text-gray-500">Tipe</p>
                                    <div className="mt-1">
                                        {selectedMutation.type === 'credit' ? (
                                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/20 border border-emerald-500/30 px-2.5 py-1 text-[11px] font-semibold text-emerald-400">
                                                <ArrowDownLeft className="w-3 h-3" /> Masuk
                                            </span>
                                        ) : (
                                            <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/20 border border-rose-500/30 px-2.5 py-1 text-[11px] font-semibold text-rose-400">
                                                <ArrowUpRight className="w-3 h-3" /> Keluar
                                            </span>
                                        )}
                                    </div>
                                </div>
                                <div className="rounded-[22px] border border-[#3a3a5a] bg-[#252540]/60 p-3">
                                    <p className="text-xs text-gray-500">Tanggal</p>
                                    <p className="text-sm text-white">{new Date(selectedMutation.createdAt).toLocaleString('id-ID')}</p>
                                </div>
                                <div className="col-span-2 rounded-[22px] border border-[#3a3a5a] bg-[#252540]/60 p-3">
                                    <p className="text-xs text-gray-500">Jumlah</p>
                                    <p className={`text-lg font-bold ${selectedMutation.type === 'credit' ? 'text-emerald-400' : 'text-rose-400'}`}>
                                        {selectedMutation.type === 'credit' ? '+' : '-'}Rp {selectedMutation.amount.toLocaleString('id-ID')}
                                    </p>
                                </div>
                                {(selectedMutation.balanceBefore !== undefined || selectedMutation.balanceAfter !== undefined) && (
                                    <>
                                        <div className="rounded-[22px] border border-[#3a3a5a] bg-[#252540]/60 p-3">
                                            <p className="text-xs text-gray-500">Saldo Sebelum</p>
                                            <p className="text-sm text-white">Rp {(selectedMutation.balanceBefore || 0).toLocaleString('id-ID')}</p>
                                        </div>
                                        <div className="rounded-[22px] border border-[#3a3a5a] bg-[#252540]/60 p-3">
                                            <p className="text-xs text-gray-500">Saldo Sesudah</p>
                                            <p className="text-sm text-white">Rp {(selectedMutation.balanceAfter || 0).toLocaleString('id-ID')}</p>
                                        </div>
                                    </>
                                )}
                                {Boolean(selectedMutation.meta?.adjustedBy) && (
                                    <div className="col-span-2 rounded-[22px] border border-[#3a3a5a] bg-[#252540]/60 p-3">
                                        <p className="text-xs text-gray-500">Diproses Oleh</p>
                                        <p className="text-sm text-white">{String(selectedMutation.meta?.adjustedBy)}</p>
                                    </div>
                                )}
                            </div>
                        </div>
                        <div className="flex justify-end border-t border-[#3a3a5a] bg-[#252540]/30 px-6 py-4">
                            <button onClick={() => setSelectedMutation(null)} className="rounded-xl bg-orange-500 px-5 py-2.5 font-semibold text-white hover:bg-orange-600 focus:ring-2 focus:ring-orange-500/50 transition-all">Tutup</button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
