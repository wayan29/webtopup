import { useEffect, useState } from 'react';
import { apiV2 } from '../api';
import { useAuthStore } from '../store/useAuthStore';
import {
    Phone,
    Shield,
    Clock,
    Loader2,
    Settings,
    LogOut,
    Menu,
    LayoutDashboard,
    Receipt,
    Repeat,
    BarChart3,
    Wallet,
    ArrowUpRight,
    ArrowDownLeft,
    ChevronLeft,
    ChevronRight,
    FileText,
    FileSpreadsheet,
    Eye,
    X
} from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';

interface Transaction {
    _id: string;
    invoiceNumber?: string;
    vendorTrxId?: string;
    product: {
        name: string;
        code: string;
        category?: string;
    };
    target: string;
    amount: number;
    status: string;
    sn?: string;
    createdAt: string;
}

interface Deposit {
    _id: string;
    amount: number;
    uniqueCode: number;
    adminFee?: number;
    totalAmount: number;
    status: string;
    createdAt: string;
}

interface Mutation {
    _id: string;
    type: 'credit' | 'debit';
    amount: number;
    description: string;
    reference?: string;
    createdAt: string;
    originalData?: any;
}

type TabType = 'dashboard' | 'transactions' | 'mutations' | 'reports';

export default function Dashboard() {
    const { user, logout } = useAuthStore();
    const navigate = useNavigate();
    const [activeTab, setActiveTab] = useState<TabType>('dashboard');
    const [isSidebarOpen, setIsSidebarOpen] = useState(false);
    const [transactions, setTransactions] = useState<Transaction[]>([]);
    const [mutations, setMutations] = useState<Mutation[]>([]);
    const [loading, setLoading] = useState(true);
    const [stats, setStats] = useState({
        total: 0,
        totalSales: 0,
        success: 0,
        pending: 0,
        processing: 0,
        failed: 0
    });

    // Pagination for transactions
    const [trxPage, setTrxPage] = useState(1);
    const [trxLimit] = useState(10);
    const [trxFilters, setTrxFilters] = useState({ status: '', startDate: '', endDate: '' });

    // Pagination for mutations
    const [mutPage, setMutPage] = useState(1);
    const [mutLimit] = useState(10);
    const [mutFilters, setMutFilters] = useState({ type: '', startDate: '', endDate: '' });
    const [selectedMutation, setSelectedMutation] = useState<Mutation | null>(null);

    useEffect(() => {
        fetchData();
    }, []);

    useEffect(() => {
        setIsSidebarOpen(false);
    }, [activeTab]);

    const handleInternalNavigate = (path: string) => {
        setIsSidebarOpen(false);
        navigate(path);
    };

    const fetchData = async () => {
        setLoading(true);
        try {
            const [trxRes, depositsRes] = await Promise.all([
                apiV2.get('/transactions'),
                apiV2.get('/deposits')
            ]);

            const trxData: Transaction[] = trxRes.data || [];
            const deposits: Deposit[] = depositsRes.data || [];

            setTransactions(trxData);

            // Calculate today stats
            const today = new Date().toDateString();
            const todayTrx = trxData.filter((t: Transaction) => new Date(t.createdAt).toDateString() === today);

            setStats({
                total: todayTrx.length,
                totalSales: todayTrx.filter(t => t.status === 'success').reduce((sum, t) => sum + t.amount, 0),
                success: todayTrx.filter(t => t.status === 'success').length,
                pending: todayTrx.filter(t => t.status === 'pending').length,
                processing: todayTrx.filter(t => t.status === 'processing').length,
                failed: todayTrx.filter(t => t.status === 'failed').length
            });

            // Build mutations from deposits and transactions
            const mutationData: Mutation[] = [];

            deposits.forEach((d: Deposit) => {
                if (d.status === 'approved') {
                    const adminFee = d.adminFee || 0;
                    const netAmount = d.amount - adminFee;
                    mutationData.push({
                        _id: d._id,
                        type: 'credit',
                        amount: netAmount,
                        description: adminFee > 0
                            ? `Deposit Saldo (Fee: Rp ${adminFee.toLocaleString('id-ID')})`
                            : 'Deposit Saldo',
                        reference: `DEP-${d._id.slice(-8).toUpperCase()}`,
                        createdAt: d.createdAt,
                        originalData: { ...d, dataType: 'deposit' }
                    });
                }
            });

            trxData.forEach((t: Transaction) => {
                if (t.status === 'success') {
                    mutationData.push({
                        _id: t._id,
                        type: 'debit',
                        amount: t.amount,
                        description: t.product?.name || 'Pembelian Produk',
                        reference: `TRX-${t._id.slice(-8).toUpperCase()}`,
                        createdAt: t.createdAt,
                        originalData: { ...t, dataType: 'transaction' }
                    });
                }
            });

            mutationData.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
            setMutations(mutationData);

        } catch (error) {
            console.error('Failed to fetch data', error);
        } finally {
            setLoading(false);
        }
    };

    const navItems = [
        { label: 'Dashboard', tab: 'dashboard' as TabType, icon: LayoutDashboard },
        { label: 'Transaksi', tab: 'transactions' as TabType, icon: Receipt },
        { label: 'Mutasi', tab: 'mutations' as TabType, icon: Repeat },
        { label: 'Laporan', tab: 'reports' as TabType, icon: BarChart3 }
    ];

    const getStatusBadge = (status: string) => {
        switch (status) {
            case 'success':
                return <span className="px-2 py-1 rounded text-xs bg-green-600/30 text-green-400">Sukses</span>;
            case 'pending':
                return <span className="px-2 py-1 rounded text-xs bg-yellow-600/30 text-yellow-400">Menunggu</span>;
            case 'processing':
                return <span className="px-2 py-1 rounded text-xs bg-blue-600/30 text-blue-400">Proses</span>;
            default:
                return <span className="px-2 py-1 rounded text-xs bg-red-600/30 text-red-400">Gagal</span>;
        }
    };

    // Filter transactions
    const filteredTransactions = transactions.filter(t => {
        if (trxFilters.status && t.status !== trxFilters.status) return false;
        if (trxFilters.startDate && new Date(t.createdAt) < new Date(trxFilters.startDate)) return false;
        if (trxFilters.endDate) {
            const endDate = new Date(trxFilters.endDate);
            endDate.setHours(23, 59, 59, 999);
            if (new Date(t.createdAt) > endDate) return false;
        }
        return true;
    });

    const paginatedTransactions = filteredTransactions.slice((trxPage - 1) * trxLimit, trxPage * trxLimit);
    const totalTrxPages = Math.ceil(filteredTransactions.length / trxLimit);

    // Filter mutations
    const filteredMutations = mutations.filter(m => {
        if (mutFilters.type && m.type !== mutFilters.type) return false;
        if (mutFilters.startDate && new Date(m.createdAt) < new Date(mutFilters.startDate)) return false;
        if (mutFilters.endDate) {
            const endDate = new Date(mutFilters.endDate);
            endDate.setHours(23, 59, 59, 999);
            if (new Date(m.createdAt) > endDate) return false;
        }
        return true;
    });

    const paginatedMutations = filteredMutations.slice((mutPage - 1) * mutLimit, mutPage * mutLimit);
    const totalMutPages = Math.ceil(filteredMutations.length / mutLimit);

    const todayTransactions = transactions.filter(t => {
        const today = new Date().toDateString();
        return new Date(t.createdAt).toDateString() === today;
    });

    const exportCSV = (data: any[], filename: string, headers: string[]) => {
        const rows = data.map(item => headers.map(h => item[h] || '-'));
        const csvContent = [headers, ...rows].map(row => row.join(',')).join('\n');
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${filename}_${new Date().toISOString().split('T')[0]}.csv`;
        link.click();
    };

    const inputClass = "w-full bg-[#1a1a1f] border border-white/10 rounded-lg px-3 py-2.5 text-white text-sm focus:border-orange-500 focus:outline-none";
    const selectClass = inputClass;

    // Render Dashboard Content
    const renderDashboard = () => (
        <>
            {/* Security Banner */}
            <div className="rounded-xl bg-gradient-to-r from-teal-600 to-teal-500 p-4 flex items-center justify-between">
                <div>
                    <p className="text-sm font-semibold text-white">Tingkatkan keamanan!</p>
                    <p className="text-xs text-white/80 mt-0.5">Gunakan fitur 2FA agar akun kamu lebih aman.</p>
                </div>
                <Shield className="w-10 h-10 text-white/80" />
            </div>

            {/* Profile & Balance Row */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="rounded-xl bg-[#25252d] p-5 relative">
                    <Link to="/settings" className="absolute top-4 right-4 text-gray-500 hover:text-white">
                        <Settings className="w-5 h-5" />
                    </Link>
                    <div className="flex items-center gap-4 mb-4">
                        <div className="w-14 h-14 rounded-full bg-gradient-to-br from-pink-400 to-pink-600 flex items-center justify-center text-xl font-bold text-white">
                            {user?.name?.charAt(0).toUpperCase() || 'U'}
                        </div>
                        <div>
                            <p className="text-lg font-semibold text-white">{user?.name || 'User'}</p>
                            <span className="text-xs px-3 py-1 rounded-full bg-teal-600 text-white">Member</span>
                        </div>
                    </div>
                    <div className="flex items-center gap-2 text-gray-400">
                        <Phone className="w-4 h-4" />
                        <span className="text-sm">{(user as any)?.phone || '-'}</span>
                    </div>
                </div>

                <div className="rounded-xl bg-[#25252d] p-5">
                    <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                            <Wallet className="w-4 h-4 text-green-500" />
                            <span className="text-sm text-gray-300">Credit</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <button className="text-gray-400 hover:text-white"><Clock className="w-4 h-4" /></button>
                            <button
                                type="button"
                                onClick={() => handleInternalNavigate('/dashboard/deposit')}
                                className="px-4 py-1.5 rounded-lg bg-orange-500 text-white text-xs font-semibold hover:bg-orange-600"
                            >
                                Top Up
                            </button>
                        </div>
                    </div>
                    <div className="text-3xl font-bold text-white">Rp {user?.balance?.toLocaleString('id-ID') || '0'}</div>
                </div>
            </div>

            {/* Stats */}
            <div>
                <h3 className="text-base font-semibold text-white mb-3">Transaksi Hari Ini</h3>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                    <div className="rounded-xl bg-[#3a3a42] p-5 text-center">
                        <p className="text-3xl font-bold text-white">{stats.total}</p>
                        <p className="text-sm text-gray-400 mt-1">Total</p>
                    </div>
                    <div className="rounded-xl bg-[#2f855a] p-5 text-center">
                        <p className="text-3xl font-bold text-white">{stats.success}</p>
                        <p className="text-sm text-white/80 mt-1">Sukses</p>
                    </div>
                    <div className="rounded-xl bg-[#c4a035] p-5 text-center">
                        <p className="text-3xl font-bold text-white">{stats.pending}</p>
                        <p className="text-sm text-white/80 mt-1">Menunggu</p>
                    </div>
                    <div className="rounded-xl bg-[#742a2a] p-5 text-center">
                        <p className="text-3xl font-bold text-white">{stats.failed}</p>
                        <p className="text-sm text-white/80 mt-1">Gagal</p>
                    </div>
                </div>
            </div>

            {/* Recent Transactions */}
            <div>
                <h3 className="text-base font-semibold text-white mb-3">Transaksi Terbaru Hari Ini</h3>
                <div className="rounded-xl bg-[#25252d] overflow-hidden">
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-white/10">
                                    <th className="text-left text-gray-400 font-medium px-4 py-3">Invoice</th>
                                    <th className="text-left text-gray-400 font-medium px-4 py-3">Produk</th>
                                    <th className="text-left text-gray-400 font-medium px-4 py-3">Tujuan</th>
                                    <th className="text-left text-gray-400 font-medium px-4 py-3">Harga</th>
                                    <th className="text-left text-gray-400 font-medium px-4 py-3">Status</th>
                                </tr>
                            </thead>
                            <tbody>
                                {loading ? (
                                    <tr><td colSpan={5} className="text-center py-8 text-gray-400"><Loader2 className="w-5 h-5 animate-spin mx-auto" /></td></tr>
                                ) : todayTransactions.length === 0 ? (
                                    <tr><td colSpan={5} className="text-center py-8 text-gray-500">Belum ada transaksi hari ini</td></tr>
                                ) : (
                                    todayTransactions.slice(0, 5).map((trx) => (
                                        <tr key={trx._id} className="border-b border-white/5 hover:bg-white/5">
                                            <td className="px-4 py-3 text-white">{trx.invoiceNumber || trx._id.slice(-8).toUpperCase()}</td>
                                            <td className="px-4 py-3 text-white">{trx.product?.name || '-'}</td>
                                            <td className="px-4 py-3 text-gray-400">{trx.target}</td>
                                            <td className="px-4 py-3 text-white">Rp {trx.amount.toLocaleString('id-ID')}</td>
                                            <td className="px-4 py-3">{getStatusBadge(trx.status)}</td>
                                        </tr>
                                    ))
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        </>
    );

    // Render Transactions Content
    const renderTransactions = () => (
        <>
            <div className="rounded-xl bg-gradient-to-r from-[#1f1f35] to-[#11111f] p-5 border border-orange-500/20">
                <h1 className="text-2xl font-bold text-white">Riwayat Transaksi</h1>
                <p className="text-gray-400 mt-1">Daftar semua transaksi yang telah kamu lakukan</p>
            </div>

            {/* Filters */}
            <div className="bg-[#25252d] rounded-xl p-4 border border-white/5">
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                    <select value={trxFilters.status} onChange={(e) => { setTrxFilters({ ...trxFilters, status: e.target.value }); setTrxPage(1); }} className={selectClass}>
                        <option value="">Semua Status</option>
                        <option value="success">Sukses</option>
                        <option value="pending">Menunggu</option>
                        <option value="processing">Proses</option>
                        <option value="failed">Gagal</option>
                    </select>
                    <input type="date" value={trxFilters.startDate} onChange={(e) => { setTrxFilters({ ...trxFilters, startDate: e.target.value }); setTrxPage(1); }} className={inputClass} />
                    <input type="date" value={trxFilters.endDate} onChange={(e) => { setTrxFilters({ ...trxFilters, endDate: e.target.value }); setTrxPage(1); }} className={inputClass} />
                    <button onClick={() => { setTrxFilters({ status: '', startDate: '', endDate: '' }); setTrxPage(1); }} className="px-4 py-2.5 bg-gray-600 hover:bg-gray-500 text-white rounded-lg text-sm font-semibold">Reset</button>
                </div>
            </div>

            {/* Table */}
            <div className="bg-[#25252d] rounded-xl overflow-hidden border border-white/5">
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-white/10">
                                <th className="text-left text-gray-400 font-medium px-4 py-3">Invoice</th>
                                <th className="text-left text-gray-400 font-medium px-4 py-3">Produk</th>
                                <th className="text-left text-gray-400 font-medium px-4 py-3">Tujuan</th>
                                <th className="text-left text-gray-400 font-medium px-4 py-3">Harga</th>
                                <th className="text-left text-gray-400 font-medium px-4 py-3">SN</th>
                                <th className="text-left text-gray-400 font-medium px-4 py-3">Tanggal</th>
                                <th className="text-left text-gray-400 font-medium px-4 py-3">Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            {loading ? (
                                <tr><td colSpan={7} className="text-center py-8"><Loader2 className="w-5 h-5 animate-spin mx-auto text-orange-500" /></td></tr>
                            ) : paginatedTransactions.length === 0 ? (
                                <tr><td colSpan={7} className="text-center py-8 text-gray-500">Tidak ada transaksi</td></tr>
                            ) : (
                                paginatedTransactions.map((trx) => (
                                    <tr key={trx._id} className="border-b border-white/5 hover:bg-white/5">
                                        <td className="px-4 py-3 text-white">{trx.invoiceNumber || trx._id.slice(-8).toUpperCase()}</td>
                                        <td className="px-4 py-3 text-white">{trx.product?.name || '-'}</td>
                                        <td className="px-4 py-3 text-gray-400">{trx.target}</td>
                                        <td className="px-4 py-3 text-white">Rp {trx.amount.toLocaleString('id-ID')}</td>
                                        <td className="px-4 py-3 text-green-400 font-mono text-xs">{trx.sn || '-'}</td>
                                        <td className="px-4 py-3 text-gray-400">{new Date(trx.createdAt).toLocaleDateString('id-ID')}</td>
                                        <td className="px-4 py-3">{getStatusBadge(trx.status)}</td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>

                {/* Pagination */}
                <div className="p-4 border-t border-white/10 flex items-center justify-between">
                    <p className="text-sm text-gray-400">Menampilkan {paginatedTransactions.length} dari {filteredTransactions.length} transaksi</p>
                    <div className="flex items-center gap-2">
                        <button onClick={() => setTrxPage(p => Math.max(1, p - 1))} disabled={trxPage === 1} className="px-3 py-2 bg-[#1a1a1f] border border-white/10 rounded-lg text-sm disabled:opacity-50 flex items-center gap-1">
                            <ChevronLeft className="w-4 h-4" /> Prev
                        </button>
                        <span className="text-sm text-gray-400">Hal {trxPage} / {totalTrxPages || 1}</span>
                        <button onClick={() => setTrxPage(p => Math.min(totalTrxPages, p + 1))} disabled={trxPage >= totalTrxPages} className="px-3 py-2 bg-[#1a1a1f] border border-white/10 rounded-lg text-sm disabled:opacity-50 flex items-center gap-1">
                            Next <ChevronRight className="w-4 h-4" />
                        </button>
                    </div>
                </div>
            </div>
        </>
    );

    // Render Mutations Content
    const renderMutations = () => (
        <>
            <div className="rounded-xl bg-gradient-to-r from-[#1f1f35] to-[#11111f] p-5 border border-orange-500/20">
                <h1 className="text-2xl font-bold text-white">Riwayat Mutasi</h1>
                <p className="text-gray-400 mt-1">Catatan keluar masuk saldo</p>
            </div>

            {/* Filters */}
            <div className="bg-[#25252d] rounded-xl p-4 border border-white/5">
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4">
                    <select value={mutFilters.type} onChange={(e) => { setMutFilters({ ...mutFilters, type: e.target.value }); setMutPage(1); }} className={selectClass}>
                        <option value="">Semua Tipe</option>
                        <option value="credit">Masuk</option>
                        <option value="debit">Keluar</option>
                    </select>
                    <input type="date" value={mutFilters.startDate} onChange={(e) => { setMutFilters({ ...mutFilters, startDate: e.target.value }); setMutPage(1); }} className={inputClass} />
                    <input type="date" value={mutFilters.endDate} onChange={(e) => { setMutFilters({ ...mutFilters, endDate: e.target.value }); setMutPage(1); }} className={inputClass} />
                    <button onClick={() => { setMutFilters({ type: '', startDate: '', endDate: '' }); setMutPage(1); }} className="px-4 py-2.5 bg-gray-600 hover:bg-gray-500 text-white rounded-lg text-sm font-semibold">Reset</button>
                </div>
                <div className="flex gap-2">
                    <button onClick={() => exportCSV(filteredMutations.map(m => ({
                        tanggal: new Date(m.createdAt).toLocaleString('id-ID'),
                        keterangan: m.description,
                        referensi: m.reference,
                        tipe: m.type === 'credit' ? 'Masuk' : 'Keluar',
                        jumlah: m.type === 'credit' ? `+${m.amount}` : `-${m.amount}`
                    })), 'mutasi', ['tanggal', 'keterangan', 'referensi', 'tipe', 'jumlah'])} className="px-4 py-2 bg-[#1a1a1f] border border-white/10 rounded-lg text-sm flex items-center gap-2 hover:bg-white/5">
                        <FileText className="w-4 h-4" /> CSV
                    </button>
                    <button onClick={() => exportCSV(filteredMutations.map(m => ({
                        tanggal: new Date(m.createdAt).toLocaleString('id-ID'),
                        keterangan: m.description,
                        referensi: m.reference,
                        tipe: m.type === 'credit' ? 'Masuk' : 'Keluar',
                        jumlah: m.type === 'credit' ? `+${m.amount}` : `-${m.amount}`
                    })), 'mutasi', ['tanggal', 'keterangan', 'referensi', 'tipe', 'jumlah'])} className="px-4 py-2 bg-[#1a1a1f] border border-white/10 rounded-lg text-sm flex items-center gap-2 hover:bg-white/5">
                        <FileSpreadsheet className="w-4 h-4" /> XLSX
                    </button>
                </div>
            </div>

            {/* Table */}
            <div className="bg-[#25252d] rounded-xl overflow-hidden border border-white/5">
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-white/10">
                                <th className="text-left text-gray-400 font-medium px-4 py-3">Tanggal</th>
                                <th className="text-left text-gray-400 font-medium px-4 py-3">Keterangan</th>
                                <th className="text-left text-gray-400 font-medium px-4 py-3">Referensi</th>
                                <th className="text-left text-gray-400 font-medium px-4 py-3">Tipe</th>
                                <th className="text-right text-gray-400 font-medium px-4 py-3">Jumlah</th>
                                <th className="text-center text-gray-400 font-medium px-4 py-3">Aksi</th>
                            </tr>
                        </thead>
                        <tbody>
                            {loading ? (
                                <tr><td colSpan={6} className="text-center py-8"><Loader2 className="w-5 h-5 animate-spin mx-auto text-orange-500" /></td></tr>
                            ) : paginatedMutations.length === 0 ? (
                                <tr><td colSpan={6} className="text-center py-8 text-gray-500">Tidak ada mutasi</td></tr>
                            ) : (
                                paginatedMutations.map((mut) => (
                                    <tr key={mut._id} className="border-b border-white/5 hover:bg-white/5">
                                        <td className="px-4 py-3 text-gray-300">{new Date(mut.createdAt).toLocaleString('id-ID')}</td>
                                        <td className="px-4 py-3 text-white">{mut.description}</td>
                                        <td className="px-4 py-3 text-blue-400 font-mono">{mut.reference || '-'}</td>
                                        <td className="px-4 py-3">
                                            {mut.type === 'credit' ? (
                                                <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold rounded-full bg-green-500/20 text-green-400">
                                                    <ArrowDownLeft className="w-3 h-3" /> Masuk
                                                </span>
                                            ) : (
                                                <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold rounded-full bg-red-500/20 text-red-400">
                                                    <ArrowUpRight className="w-3 h-3" /> Keluar
                                                </span>
                                            )}
                                        </td>
                                        <td className={`px-4 py-3 text-right font-bold ${mut.type === 'credit' ? 'text-green-400' : 'text-red-400'}`}>
                                            {mut.type === 'credit' ? '+' : '-'}Rp {mut.amount.toLocaleString('id-ID')}
                                        </td>
                                        <td className="px-4 py-3 text-center">
                                            <button
                                                onClick={() => setSelectedMutation(mut)}
                                                className="text-orange-400 hover:text-orange-300 bg-orange-500/20 p-1.5 rounded"
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

                {/* Pagination */}
                <div className="p-4 border-t border-white/10 flex items-center justify-between">
                    <p className="text-sm text-gray-400">Menampilkan {paginatedMutations.length} dari {filteredMutations.length} mutasi</p>
                    <div className="flex items-center gap-2">
                        <button onClick={() => setMutPage(p => Math.max(1, p - 1))} disabled={mutPage === 1} className="px-3 py-2 bg-[#1a1a1f] border border-white/10 rounded-lg text-sm disabled:opacity-50 flex items-center gap-1">
                            <ChevronLeft className="w-4 h-4" /> Prev
                        </button>
                        <span className="text-sm text-gray-400">Hal {mutPage} / {totalMutPages || 1}</span>
                        <button onClick={() => setMutPage(p => Math.min(totalMutPages, p + 1))} disabled={mutPage >= totalMutPages} className="px-3 py-2 bg-[#1a1a1f] border border-white/10 rounded-lg text-sm disabled:opacity-50 flex items-center gap-1">
                            Next <ChevronRight className="w-4 h-4" />
                        </button>
                    </div>
                </div>
            </div>
        </>
    );

    // Render Reports Content
    const renderReports = () => {
        const totalCredit = mutations.filter(m => m.type === 'credit').reduce((sum, m) => sum + m.amount, 0);
        const totalDebit = mutations.filter(m => m.type === 'debit').reduce((sum, m) => sum + m.amount, 0);
        const totalTrx = transactions.length;
        const successTrx = transactions.filter(t => t.status === 'success').length;

        return (
            <>
                <div className="rounded-xl bg-gradient-to-r from-[#1f1f35] to-[#11111f] p-5 border border-orange-500/20">
                    <h1 className="text-2xl font-bold text-white">Laporan</h1>
                    <p className="text-gray-400 mt-1">Ringkasan aktivitas akun</p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                    <div className="bg-[#25252d] rounded-xl p-5 border border-white/5">
                        <p className="text-sm text-gray-400 mb-2">Total Deposit</p>
                        <p className="text-2xl font-bold text-green-400">Rp {totalCredit.toLocaleString('id-ID')}</p>
                    </div>
                    <div className="bg-[#25252d] rounded-xl p-5 border border-white/5">
                        <p className="text-sm text-gray-400 mb-2">Total Pembelian</p>
                        <p className="text-2xl font-bold text-red-400">Rp {totalDebit.toLocaleString('id-ID')}</p>
                    </div>
                    <div className="bg-[#25252d] rounded-xl p-5 border border-white/5">
                        <p className="text-sm text-gray-400 mb-2">Total Transaksi</p>
                        <p className="text-2xl font-bold text-white">{totalTrx}</p>
                    </div>
                    <div className="bg-[#25252d] rounded-xl p-5 border border-white/5">
                        <p className="text-sm text-gray-400 mb-2">Transaksi Sukses</p>
                        <p className="text-2xl font-bold text-white">{successTrx} <span className="text-sm text-gray-400">({totalTrx > 0 ? Math.round((successTrx / totalTrx) * 100) : 0}%)</span></p>
                    </div>
                </div>

                <div className="bg-[#25252d] rounded-xl p-5 border border-white/5">
                    <h3 className="text-lg font-semibold text-white mb-4">Saldo Saat Ini</h3>
                    <p className="text-4xl font-bold text-orange-400">Rp {user?.balance?.toLocaleString('id-ID') || '0'}</p>
                </div>
            </>
        );
    };

    const activeTabLabel = navItems.find((item) => item.tab === activeTab)?.label || 'Dashboard';

    return (
        <div className="min-h-screen bg-[#1a1a1f] text-white flex">
            {isSidebarOpen && (
                <div
                    className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm lg:hidden"
                    onClick={() => setIsSidebarOpen(false)}
                    aria-hidden="true"
                />
            )}

            {/* Sidebar */}
            <aside
                className={`
                    fixed inset-y-0 left-0 z-40 w-72 max-w-[85vw] bg-[#10101a] border-r border-white/5
                    p-4 flex flex-col overflow-y-auto transform transition-transform duration-200 ease-out
                    ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'}
                    lg:static lg:translate-x-0
                `}
            >
                <div className="flex items-center justify-between">
                    <Link to="/" className="flex items-center gap-3">
                        <div className="h-10 w-10 rounded-2xl bg-gradient-to-br from-orange-400 via-amber-500 to-pink-500 text-white flex items-center justify-center font-bold shadow-lg shadow-orange-500/30">
                            TV
                        </div>
                        <div>
                            <p className="text-sm font-semibold text-white">User Panel</p>
                        </div>
                    </Link>
                    <button
                        onClick={() => setIsSidebarOpen(false)}
                        className="lg:hidden text-gray-400 hover:text-white"
                        aria-label="Tutup menu"
                    >
                        <X className="w-6 h-6" />
                    </button>
                </div>

                <div className="mt-6 rounded-2xl border border-white/10 bg-[#1b1b28] p-4">
                    <div className="flex items-center gap-3">
                        <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-pink-400 to-orange-500 text-white flex items-center justify-center text-lg font-bold">
                            {user?.name?.charAt(0).toUpperCase() || 'U'}
                        </div>
                        <div className="min-w-0">
                            <p className="text-sm font-semibold text-white truncate">{user?.name || 'User'}</p>
                            <p className="text-xs text-gray-400 truncate">{user?.email || '-'}</p>
                        </div>
                    </div>
                    <div className="mt-4 rounded-xl border border-white/5 bg-[#141421] px-3 py-2">
                        <div className="flex items-center justify-between text-[11px] uppercase tracking-wide text-gray-400">
                            <span>Saldo</span>
                            <span className="text-sm font-semibold text-orange-400">
                                Rp {user?.balance?.toLocaleString('id-ID') || '0'}
                            </span>
                        </div>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                        <button
                            type="button"
                            onClick={() => handleInternalNavigate('/dashboard/deposit')}
                            className="inline-flex items-center justify-center rounded-lg bg-orange-500 px-3 py-2 text-xs font-semibold text-white hover:bg-orange-600 transition-colors"
                        >
                            Top Up
                        </button>
                        <Link
                            to="/settings"
                            className="inline-flex items-center justify-center rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-gray-200 hover:border-orange-400/40 hover:bg-white/10 transition-colors"
                        >
                            Pengaturan
                        </Link>
                    </div>
                </div>

                <div className="mt-6 flex items-center justify-between text-[11px] uppercase tracking-[0.28em] text-gray-500">
                    <span>Menu</span>
                    <span className="text-orange-300">User</span>
                </div>
                <nav className="mt-4 space-y-1 flex-1">
                    {navItems.map(({ label, tab, icon: Icon }) => {
                        const active = activeTab === tab;
                        return (
                            <button
                                key={label}
                                onClick={() => {
                                    setActiveTab(tab);
                                    setIsSidebarOpen(false);
                                }}
                                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border transition-all text-left ${active
                                    ? 'bg-orange-500/15 border-orange-400/40 text-white shadow-[0_12px_30px_rgba(255,138,76,0.25)]'
                                    : 'text-gray-300 border-transparent hover:border-white/10 hover:bg-white/5'
                                    }`}
                            >
                                <span className={`h-9 w-9 rounded-lg flex items-center justify-center border ${active
                                    ? 'bg-orange-500/20 border-orange-400/40 text-orange-300'
                                    : 'bg-[#12121d] border-white/10 text-gray-400'
                                    }`}>
                                    <Icon className="w-4 h-4" />
                                </span>
                                <span className="text-sm font-medium">{label}</span>
                            </button>
                        );
                    })}
                </nav>

                <button
                    onClick={() => { logout(); navigate('/login'); }}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-xl border border-white/10 text-orange-300 hover:text-orange-200 hover:border-orange-400/40 hover:bg-orange-500/10 transition-colors"
                >
                    <LogOut className="w-4 h-4" />
                    <span className="text-sm">Keluar</span>
                </button>
            </aside>

            {/* Main Content */}
            <main className="flex-1 p-4 sm:p-6 lg:p-8 space-y-5 overflow-auto">
                <div className="lg:hidden flex items-center justify-between gap-3">
                    <button
                        onClick={() => setIsSidebarOpen(true)}
                        className="inline-flex items-center justify-center h-10 w-10 rounded-xl border border-white/10 bg-white/5 text-gray-200 hover:bg-white/10"
                        aria-label="Buka menu"
                    >
                        <Menu className="w-5 h-5" />
                    </button>
                    <div className="flex-1 text-center">
                        <p className="text-[11px] uppercase tracking-[0.3em] text-gray-500">Dashboard</p>
                        <p className="text-sm font-semibold text-white">{activeTabLabel}</p>
                    </div>
                    <button
                        type="button"
                        onClick={() => handleInternalNavigate('/dashboard/deposit')}
                        className="inline-flex items-center justify-center rounded-xl bg-orange-500 px-3 py-2 text-xs font-semibold text-white hover:bg-orange-600"
                    >
                        Top Up
                    </button>
                </div>

                {activeTab === 'dashboard' && renderDashboard()}
                {activeTab === 'transactions' && renderTransactions()}
                {activeTab === 'mutations' && renderMutations()}
                {activeTab === 'reports' && renderReports()}
            </main>

            {/* Mutation Detail Modal */}
            {selectedMutation && (
                <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
                    <div className="bg-[#25252d] border border-white/10 rounded-xl shadow-xl w-full max-w-md overflow-hidden">
                        <div className="flex items-center justify-between p-4 border-b border-white/10 bg-[#1a1a1f]">
                            <h2 className="text-lg font-semibold text-white">Detail Mutasi</h2>
                            <button onClick={() => setSelectedMutation(null)} className="text-gray-400 hover:text-white">
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        <div className="p-5 space-y-4">
                            {/* Type Badge */}
                            <div className="flex justify-center">
                                <span className={`px-4 py-2 rounded-full text-sm font-semibold flex items-center gap-2 ${selectedMutation.type === 'credit' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
                                    }`}>
                                    {selectedMutation.type === 'credit' ? <ArrowDownLeft className="w-4 h-4" /> : <ArrowUpRight className="w-4 h-4" />}
                                    {selectedMutation.type === 'credit' ? 'SALDO MASUK' : 'SALDO KELUAR'}
                                </span>
                            </div>

                            {/* Info Rows */}
                            <div className="bg-[#1a1a1f] rounded-lg p-4 space-y-3 border border-white/10">
                                <div className="flex justify-between">
                                    <span className="text-sm text-gray-400">Referensi</span>
                                    <span className="text-sm font-mono text-blue-400">{selectedMutation.reference}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-sm text-gray-400">Tanggal</span>
                                    <span className="text-sm text-white">{new Date(selectedMutation.createdAt).toLocaleString('id-ID')}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-sm text-gray-400">Keterangan</span>
                                    <span className="text-sm text-white text-right max-w-[200px]">{selectedMutation.description}</span>
                                </div>
                                <hr className="border-white/10" />
                                <div className="flex justify-between">
                                    <span className="text-sm text-gray-400">Jumlah</span>
                                    <span className={`text-lg font-bold ${selectedMutation.type === 'credit' ? 'text-green-400' : 'text-red-400'}`}>
                                        {selectedMutation.type === 'credit' ? '+' : '-'}Rp {selectedMutation.amount.toLocaleString('id-ID')}
                                    </span>
                                </div>

                                {/* Additional data for deposits */}
                                {selectedMutation.originalData?.dataType === 'deposit' && (
                                    <>
                                        <hr className="border-white/10" />
                                        <p className="text-xs text-orange-400 font-semibold uppercase">Detail Deposit</p>
                                        <div className="flex justify-between">
                                            <span className="text-sm text-gray-400">Nominal Deposit</span>
                                            <span className="text-sm text-white">Rp {selectedMutation.originalData.amount?.toLocaleString('id-ID')}</span>
                                        </div>
                                        {(selectedMutation.originalData.adminFee || 0) > 0 && (
                                            <div className="flex justify-between">
                                                <span className="text-sm text-gray-400">Biaya Admin</span>
                                                <span className="text-sm text-red-400">-Rp {selectedMutation.originalData.adminFee?.toLocaleString('id-ID')}</span>
                                            </div>
                                        )}
                                        {selectedMutation.originalData.uniqueCode > 0 && (
                                            <div className="flex justify-between">
                                                <span className="text-sm text-gray-400">Kode Unik</span>
                                                <span className="text-sm text-green-400">+{selectedMutation.originalData.uniqueCode}</span>
                                            </div>
                                        )}
                                        <div className="flex justify-between">
                                            <span className="text-sm text-gray-400">Total Transfer</span>
                                            <span className="text-sm text-orange-400 font-semibold">Rp {selectedMutation.originalData.totalAmount?.toLocaleString('id-ID')}</span>
                                        </div>
                                    </>
                                )}

                                {/* Additional data for transactions */}
                                {selectedMutation.originalData?.dataType === 'transaction' && (
                                    <>
                                        <hr className="border-white/10" />
                                        <p className="text-xs text-orange-400 font-semibold uppercase">Detail Transaksi</p>
                                        <div className="flex justify-between">
                                            <span className="text-sm text-gray-400">Produk</span>
                                            <span className="text-sm text-white text-right max-w-[180px]">{selectedMutation.originalData.product?.name || '-'}</span>
                                        </div>
                                        <div className="flex justify-between">
                                            <span className="text-sm text-gray-400">Status</span>
                                            <span className="text-sm text-green-400 font-semibold">Sukses</span>
                                        </div>
                                    </>
                                )}
                            </div>

                            <button
                                onClick={() => setSelectedMutation(null)}
                                className="w-full py-2.5 px-4 border border-white/10 rounded-lg text-sm font-medium text-gray-300 hover:bg-white/5 transition-colors"
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
