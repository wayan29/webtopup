import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Check, CheckCircle, Clock, Copy, CreditCard, Eye, X, XCircle } from 'lucide-react';
import { apiV2 } from '../api';

interface PaymentCategory {
    _id: string;
    name: string;
}

interface PaymentMethod {
    _id: string;
    name: string;
    category: PaymentCategory | string;
    accountNumber: string;
    accountName: string;
    icon?: string;
    minAmount: number;
    maxAmount: number;
}

interface Deposit {
    _id: string;
    amount: number;
    uniqueCode: number;
    adminFee?: number;
    totalAmount: number;
    paymentMethod?: PaymentMethod;
    status: 'pending' | 'approved' | 'rejected';
    createdAt: string;
}

interface PaymentInfo {
    bankName: string;
    accountNumber: string;
    accountName: string;
    amount: number;
    uniqueCode: number;
    totalAmount: number;
    adminFee?: number;
    netAmount?: number;
}

const getCategoryName = (category: PaymentCategory | string): string => {
    if (typeof category === 'string') return category;
    return category?.name || '-';
};

const depositStatusConfig = {
    approved: {
        label: 'DITERIMA',
        icon: CheckCircle,
        className: 'border border-emerald-500/30 bg-emerald-500/20 text-emerald-400'
    },
    pending: {
        label: 'MENUNGGU',
        icon: Clock,
        className: 'border border-amber-500/30 bg-amber-500/20 text-amber-500'
    },
    rejected: {
        label: 'DITOLAK',
        icon: XCircle,
        className: 'border border-rose-500/30 bg-rose-500/20 text-rose-400'
    }
} as const;

export default function Deposit() {
    const location = useLocation();
    const [amount, setAmount] = useState('');
    const [selectedMethod, setSelectedMethod] = useState<string>('');
    const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);
    const [deposits, setDeposits] = useState<Deposit[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [paymentInfo, setPaymentInfo] = useState<PaymentInfo | null>(null);
    const [copied, setCopied] = useState<string | null>(null);
    const [selectedDeposit, setSelectedDeposit] = useState<Deposit | null>(null);

    const fetchPaymentMethods = async () => {
        try {
            const res = await apiV2.get('/payment-methods/active');
            setPaymentMethods(res.data);
        } catch (fetchError) {
            console.error('Failed to fetch payment methods', fetchError);
        }
    };

    const fetchDeposits = async () => {
        try {
            const res = await apiV2.get('/deposits');
            setDeposits(res.data);
        } catch (fetchError) {
            console.error('Failed to fetch deposits', fetchError);
        }
    };

    useEffect(() => {
        fetchPaymentMethods();
        fetchDeposits();
    }, []);

    const selectedPaymentMethod = paymentMethods.find((method) => method._id === selectedMethod);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setPaymentInfo(null);
        setLoading(true);

        try {
            const payload = {
                amount: Number(amount),
                paymentMethodId: selectedMethod
            };
            const res = await apiV2
                .post('/deposits', payload);
            setPaymentInfo(res.data.paymentInfo);
            setAmount('');
            setSelectedMethod('');
            fetchDeposits();
        } catch (err: any) {
            setError(err.response?.data?.message || 'Failed to submit deposit');
        } finally {
            setLoading(false);
        }
    };

    const handleCopy = (text: string, type: string) => {
        navigator.clipboard.writeText(text);
        setCopied(type);
        setTimeout(() => setCopied(null), 2000);
    };

    const quickAmounts = [50000, 100000, 200000, 500000, 1000000];
    const isEmbeddedInDashboard = location.pathname.startsWith('/dashboard/');
    const approvedDeposits = deposits.filter((deposit) => deposit.status === 'approved');
    const pendingDeposits = deposits.filter((deposit) => deposit.status === 'pending');
    const approvedBalanceTotal = approvedDeposits.reduce(
        (total, deposit) => total + (deposit.amount - (deposit.adminFee || 0)),
        0
    );
    const latestPendingDeposit = pendingDeposits[0];

    return (
        <div
            className={
                isEmbeddedInDashboard
                    ? 'space-y-6 text-gray-200'
                    : 'min-h-screen space-y-6 bg-[#0f0f1f] p-4 md:p-6 text-gray-200'
            }
        >
            <div className="relative overflow-hidden rounded-[30px] border border-[#3a3a5a] bg-[#1a1a2e] p-6 shadow-2xl sm:p-7">
                <div className="absolute inset-0 pointer-events-none">
                    <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,_rgba(249,115,22,0.1),_transparent_30%),radial-gradient(circle_at_bottom_left,_rgba(37,37,64,0.9),_transparent_38%)]" />
                </div>
                <div className="relative grid gap-5 lg:grid-cols-[1.6fr_1fr] lg:items-start">
                    <div className="space-y-4">
                        <div className="inline-flex rounded-full border border-orange-500/30 bg-orange-500/10 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.38em] text-orange-400">
                            Deposit Area
                        </div>
                        <div className="space-y-2">
                            <h1 className="text-3xl font-bold text-white sm:text-[2.1rem]">Top up saldo member</h1>
                            <p className="max-w-2xl text-sm leading-7 text-gray-400 sm:text-[15px]">
                                Request deposit tetap berada di member area. Pilih metode pembayaran,
                                kirim sesuai nominal transfer, lalu tunggu verifikasi admin.
                            </p>
                        </div>
                        <div className="grid gap-3 sm:grid-cols-3">
                            <div className="rounded-[22px] border border-[#3a3a5a] bg-[#252540] p-4">
                                <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-gray-500">Total Request</p>
                                <p className="mt-3 text-2xl font-bold text-white">{deposits.length}</p>
                                <p className="mt-1 text-xs text-gray-400">Semua histori deposit Anda</p>
                            </div>
                            <div className="rounded-[22px] border border-[#3a3a5a] bg-[#252540] p-4">
                                <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-gray-500">Pending</p>
                                <p className="mt-3 text-2xl font-bold text-white">{pendingDeposits.length}</p>
                                <p className="mt-1 text-xs text-amber-500">Menunggu pengecekan admin</p>
                            </div>
                            <div className="rounded-[22px] border border-[#3a3a5a] bg-[#252540] p-4">
                                <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-gray-500">Saldo Disetujui</p>
                                <p className="mt-3 text-2xl font-bold text-white">
                                    Rp {approvedBalanceTotal.toLocaleString('id-ID')}
                                </p>
                                <p className="mt-1 text-xs text-emerald-400">Akumulasi saldo yang sudah masuk</p>
                            </div>
                        </div>
                    </div>

                    <div className="rounded-[28px] border border-orange-500/20 bg-gradient-to-r from-orange-500 to-amber-600 p-5 text-white shadow-xl shadow-orange-500/20">
                        <div className="flex items-center justify-between gap-3">
                            <div>
                                <p className="text-[11px] font-semibold uppercase tracking-[0.34em] text-white/80">Verifikasi Deposit</p>
                                <h2 className="mt-2 text-2xl font-bold leading-tight">Manual tapi tetap rapi</h2>
                            </div>
                            <span className="rounded-full bg-black/20 px-3 py-1 text-xs font-semibold text-white">
                                Member Area
                            </span>
                        </div>
                        <div className="mt-6 space-y-3 rounded-[22px] bg-black/20 p-4 backdrop-blur-sm">
                            <div className="flex items-start justify-between gap-4">
                                <div>
                                    <p className="text-xs uppercase tracking-[0.28em] text-white/60">Status terbaru</p>
                                    <p className="mt-2 text-sm font-medium text-white">
                                        {latestPendingDeposit
                                            ? `Ada ${pendingDeposits.length} deposit yang sedang menunggu verifikasi.`
                                            : 'Saat ini tidak ada deposit pending.'}
                                    </p>
                                </div>
                                <Clock className="mt-1 h-5 w-5 shrink-0 text-white/80" />
                            </div>
                            <div className="rounded-[18px] bg-black/20 p-4">
                                <p className="text-xs text-white/60">Tips aman transfer</p>
                                <p className="mt-2 text-sm leading-6 text-white/90">
                                    Kirim sesuai total transfer termasuk kode unik. Setelah itu cukup tunggu admin
                                    memeriksa mutasi bank.
                                </p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {paymentInfo && (
                <div className="space-y-4 rounded-[28px] border border-emerald-500/30 bg-emerald-500/10 p-6 shadow-2xl">
                    <div className="flex items-center gap-2 text-emerald-400">
                        <CheckCircle className="h-5 w-5" />
                        <h3 className="font-semibold text-emerald-400">Deposit Berhasil Dibuat!</h3>
                    </div>
                    <p className="text-sm text-emerald-100/70">Silakan transfer ke rekening berikut:</p>

                    <div className="space-y-3 rounded-[24px] border border-[#3a3a5a] bg-[#1a1a2e] p-5">
                        <div className="flex items-center justify-between">
                            <span className="text-sm text-gray-400">Bank</span>
                            <span className="font-semibold text-white">{paymentInfo.bankName}</span>
                        </div>
                        <div className="flex items-center justify-between">
                            <span className="text-sm text-gray-400">No. Rekening</span>
                            <div className="flex items-center gap-2">
                                <span className="font-mono font-semibold text-white">{paymentInfo.accountNumber}</span>
                                <button
                                    onClick={() => handleCopy(paymentInfo.accountNumber, 'account')}
                                    className="text-orange-400 hover:text-orange-300"
                                >
                                    {copied === 'account' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                                </button>
                            </div>
                        </div>
                        <div className="flex items-center justify-between">
                            <span className="text-sm text-gray-400">Atas Nama</span>
                            <span className="font-semibold text-white">{paymentInfo.accountName}</span>
                        </div>
                        <hr className="border-[#3a3a5a]" />
                        <div className="flex items-center justify-between">
                            <span className="text-sm text-gray-400">Nominal</span>
                            <span className="text-white">Rp {paymentInfo.amount.toLocaleString('id-ID')}</span>
                        </div>
                        <div className="flex items-center justify-between">
                            <span className="text-sm text-gray-400">Kode Unik</span>
                            <span className="font-semibold text-emerald-400">+ Rp {paymentInfo.uniqueCode.toLocaleString('id-ID')}</span>
                        </div>
                        <hr className="border-[#3a3a5a]" />
                        <div className="flex items-center justify-between">
                            <span className="text-sm font-medium text-gray-300">Total Transfer</span>
                            <div className="flex items-center gap-2">
                                <span className="text-lg font-bold text-orange-500">Rp {paymentInfo.totalAmount.toLocaleString('id-ID')}</span>
                                <button
                                    onClick={() => handleCopy(paymentInfo.totalAmount.toString(), 'total')}
                                    className="text-orange-400 hover:text-orange-300"
                                >
                                    {copied === 'total' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                                </button>
                            </div>
                        </div>
                        {(paymentInfo.adminFee ?? 0) > 0 && (
                            <>
                                <hr className="border-[#3a3a5a]" />
                                <div className="flex items-center justify-between">
                                    <span className="text-sm text-gray-400">Biaya Admin</span>
                                    <span className="font-semibold text-rose-400">- Rp {(paymentInfo.adminFee || 0).toLocaleString('id-ID')}</span>
                                </div>
                                <div className="mt-2 -mx-1 flex items-center justify-between rounded-[18px] border border-[#3a3a5a] bg-[#252540] p-3">
                                    <span className="text-sm font-medium text-gray-300">Saldo Diterima</span>
                                    <span className="text-lg font-bold text-emerald-400">
                                        Rp {(paymentInfo.netAmount || paymentInfo.amount).toLocaleString('id-ID')}
                                    </span>
                                </div>
                            </>
                        )}
                    </div>

                    <div className="rounded-[20px] border border-amber-500/30 bg-amber-500/10 p-4">
                        <p className="text-sm text-amber-400">
                            <strong>Penting:</strong> Transfer sesuai nominal di atas agar deposit bisa diverifikasi admin tanpa kendala. Saldo masuk setelah request disetujui.
                        </p>
                    </div>

                    <button
                        onClick={() => setPaymentInfo(null)}
                        className="w-full rounded-2xl border border-[#3a3a5a] bg-[#252540] px-4 py-3 text-sm font-semibold text-gray-300 transition-colors hover:bg-[#3a3a5a]"
                    >
                        Tutup
                    </button>
                </div>
            )}

            {!paymentInfo && (
                <div className="grid gap-6 xl:grid-cols-[1.4fr_0.78fr]">
                    <div className="rounded-[30px] border border-[#3a3a5a] bg-[#1a1a2e] p-6 shadow-2xl">
                        <div className="mb-5 flex items-start justify-between gap-4">
                            <div>
                                <p className="text-[11px] font-semibold uppercase tracking-[0.35em] text-gray-500">Request Deposit</p>
                                <h2 className="mt-2 text-2xl font-bold text-white">Buat instruksi transfer baru</h2>
                                <p className="mt-2 text-sm leading-6 text-gray-400">
                                    Pilih metode pembayaran, tentukan nominal, lalu kirim sesuai total transfer yang muncul.
                                </p>
                            </div>
                            <div className="hidden rounded-[20px] border border-[#3a3a5a] bg-[#252540] px-4 py-3 text-right md:block">
                                <p className="text-[11px] uppercase tracking-[0.28em] text-gray-500">Flow</p>
                                <p className="mt-2 text-sm font-semibold text-gray-300">Transfer lalu tunggu verifikasi</p>
                            </div>
                        </div>

                        <form onSubmit={handleSubmit} className="space-y-5">
                            {error && (
                                <div className="rounded-[20px] border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-400">
                                    {error}
                                </div>
                            )}

                            <div>
                                <label className="mb-3 block text-sm font-medium text-gray-300">
                                    Pilih Metode Pembayaran
                                </label>
                                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                    {paymentMethods.map((method) => (
                                        <button
                                            key={method._id}
                                            type="button"
                                            onClick={() => setSelectedMethod(method._id)}
                                            className={`rounded-[24px] border p-4 text-left transition-all ${selectedMethod === method._id
                                                ? 'border-orange-500 bg-orange-500/10 shadow-lg shadow-orange-500/10'
                                                : 'border-[#3a3a5a] bg-[#252540] hover:border-[#3a3a5a]/80 hover:bg-[#252540]/80'
                                                }`}
                                        >
                                            <div className="flex items-center gap-3">
                                                <div
                                                    className={`flex h-11 w-11 items-center justify-center overflow-hidden rounded-[16px] border ${selectedMethod === method._id
                                                        ? 'border-orange-500/30 bg-orange-500/20'
                                                        : 'border-[#3a3a5a] bg-[#1a1a2e]'
                                                        }`}
                                                >
                                                    {method.icon ? (
                                                        <img src={method.icon} alt={method.name} className="h-full w-full object-cover" />
                                                    ) : (
                                                        <CreditCard
                                                            className={`h-5 w-5 ${selectedMethod === method._id ? 'text-orange-400' : 'text-gray-500'}`}
                                                        />
                                                    )}
                                                </div>
                                                <div className="min-w-0">
                                                    <p className="font-semibold text-white">{method.name}</p>
                                                    <p className="text-xs text-gray-400">{getCategoryName(method.category)}</p>
                                                </div>
                                            </div>
                                        </button>
                                    ))}
                                </div>
                                {paymentMethods.length === 0 && (
                                    <p className="py-4 text-center text-sm text-gray-500">
                                        Tidak ada metode pembayaran tersedia
                                    </p>
                                )}
                            </div>

                            <div>
                                <label htmlFor="amount" className="mb-2 block text-sm font-medium text-gray-300">
                                    Nominal Deposit
                                </label>
                                <div className="relative rounded-[20px]">
                                    <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-4">
                                        <span className="text-sm text-gray-500">Rp</span>
                                    </div>
                                    <input
                                        type="number"
                                        name="amount"
                                        id="amount"
                                        min={selectedPaymentMethod?.minAmount || 10000}
                                        max={selectedPaymentMethod?.maxAmount || 5000000}
                                        required
                                        className="block w-full rounded-[20px] border border-[#3a3a5a] bg-[#252540] px-4 py-3 pl-12 text-white placeholder-gray-500 outline-none transition focus:border-orange-500 focus:ring-4 focus:ring-orange-500/20"
                                        placeholder="0"
                                        value={amount}
                                        onChange={(e) => setAmount(e.target.value)}
                                    />
                                </div>
                                {selectedPaymentMethod && (
                                    <p className="mt-2 text-xs text-gray-500">
                                        Min: Rp {selectedPaymentMethod.minAmount.toLocaleString('id-ID')} - Max: Rp {selectedPaymentMethod.maxAmount.toLocaleString('id-ID')}
                                    </p>
                                )}
                            </div>

                            <div className="flex flex-wrap gap-2">
                                {quickAmounts.map((amt) => (
                                    <button
                                        key={amt}
                                        type="button"
                                        onClick={() => setAmount(amt.toString())}
                                        className={`rounded-full border px-4 py-2 text-sm font-semibold transition-colors ${amount === amt.toString()
                                            ? 'border-orange-500 bg-orange-500/20 text-orange-400'
                                            : 'border-[#3a3a5a] bg-[#252540] text-gray-400 hover:bg-[#3a3a5a]'
                                            }`}
                                    >
                                        Rp {amt.toLocaleString('id-ID')}
                                    </button>
                                ))}
                            </div>

                            <button
                                type="submit"
                                disabled={loading || !selectedMethod || !amount}
                                className="flex w-full justify-center rounded-[22px] bg-gradient-to-r from-orange-500 to-amber-600 px-4 py-3 text-sm font-semibold text-white shadow-xl shadow-orange-500/20 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                {loading ? 'Memproses...' : 'Request Deposit'}
                            </button>
                        </form>
                    </div>

                    <div className="space-y-5">
                        <div className="rounded-[28px] border border-[#3a3a5a] bg-[#1a1a2e] p-5 shadow-2xl">
                            <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-gray-500">Panduan Cepat</p>
                            <div className="mt-4 space-y-3">
                                {[
                                    'Pilih rekening atau e-wallet yang tersedia.',
                                    'Masukkan nominal sesuai kebutuhan saldo.',
                                    'Transfer sesuai total transfer termasuk kode unik.',
                                    'Tunggu admin mengecek mutasi lalu saldo masuk.'
                                ].map((step, index) => (
                                    <div key={step} className="flex gap-3 rounded-[18px] border border-[#3a3a5a] bg-[#252540] p-3">
                                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#1a1a2e] text-sm font-bold text-orange-500">
                                            {index + 1}
                                        </span>
                                        <p className="text-sm leading-6 text-gray-300">{step}</p>
                                    </div>
                                ))}
                            </div>
                        </div>

                        <div className="rounded-[28px] border border-[#3a3a5a] bg-[#252540] p-5">
                            <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-gray-500">Catatan</p>
                            <div className="mt-4 space-y-3 text-sm leading-6 text-gray-400">
                                <p>Deposit tidak diproses otomatis. Admin akan memverifikasi mutasi bank terlebih dahulu.</p>
                                <p>Jika nominal transfer tidak sesuai, proses approval bisa tertunda atau perlu klarifikasi tambahan.</p>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            <div className="overflow-hidden rounded-[30px] border border-[#3a3a5a] bg-[#1a1a2e] shadow-2xl">
                <div className="border-b border-[#3a3a5a] px-6 py-5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                            <p className="text-[11px] font-semibold uppercase tracking-[0.34em] text-gray-500">Riwayat Deposit</p>
                            <h3 className="mt-2 text-xl font-bold text-white">Pantau status deposit Anda</h3>
                        </div>
                        <div className="rounded-full border border-[#3a3a5a] bg-[#252540] px-4 py-2 text-sm font-medium text-gray-400">
                            {deposits.length} transaksi
                        </div>
                    </div>
                </div>
                <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-[#3a3a5a]">
                        <thead className="bg-[#252540]/50">
                            <tr>
                                <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-[0.28em] text-gray-500">Tanggal</th>
                                <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-[0.28em] text-gray-500">Bank</th>
                                <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-[0.28em] text-gray-500">Nominal</th>
                                <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-[0.28em] text-gray-500">Kode Unik</th>
                                <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-[0.28em] text-gray-500">Total</th>
                                <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-[0.28em] text-gray-500">Fee</th>
                                <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-[0.28em] text-gray-500">Diterima</th>
                                <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-[0.28em] text-gray-500">Status</th>
                                <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-[0.28em] text-gray-500">Aksi</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-[#3a3a5a] bg-[#1a1a2e]">
                            {deposits.length === 0 ? (
                                <tr>
                                    <td colSpan={9} className="px-6 py-10 text-center text-sm text-gray-500">
                                        Belum ada riwayat deposit.
                                    </td>
                                </tr>
                            ) : (
                                deposits.map((deposit) => {
                                    const statusMeta = depositStatusConfig[deposit.status];
                                    const StatusIcon = statusMeta.icon;

                                    return (
                                        <tr key={deposit._id} className="transition-colors hover:bg-[#252540]/80">
                                            <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-400">
                                                {new Date(deposit.createdAt).toLocaleDateString('id-ID')} {new Date(deposit.createdAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}
                                            </td>
                                            <td className="whitespace-nowrap px-6 py-4 text-sm text-white">
                                                <div className="flex items-center gap-2">
                                                    <div className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-[14px] border border-[#3a3a5a] bg-[#252540]">
                                                        {deposit.paymentMethod?.icon ? (
                                                            <img src={deposit.paymentMethod.icon} alt={deposit.paymentMethod.name} className="h-full w-full object-cover" />
                                                        ) : (
                                                            <CreditCard className="h-4 w-4 text-gray-500" />
                                                        )}
                                                    </div>
                                                    <span>{deposit.paymentMethod?.name || '-'}</span>
                                                </div>
                                            </td>
                                            <td className="whitespace-nowrap px-6 py-4 text-sm text-white">
                                                Rp {deposit.amount.toLocaleString('id-ID')}
                                            </td>
                                            <td className="whitespace-nowrap px-6 py-4 text-sm font-medium text-emerald-400">
                                                +{deposit.uniqueCode || 0}
                                            </td>
                                            <td className="whitespace-nowrap px-6 py-4 text-sm font-medium text-white">
                                                Rp {(deposit.totalAmount || deposit.amount).toLocaleString('id-ID')}
                                            </td>
                                            <td className="whitespace-nowrap px-6 py-4 text-sm font-medium text-rose-400">
                                                {(deposit.adminFee || 0) > 0 ? `-Rp ${(deposit.adminFee || 0).toLocaleString('id-ID')}` : '-'}
                                            </td>
                                            <td className="whitespace-nowrap px-6 py-4 text-sm font-bold text-emerald-400">
                                                {deposit.status === 'approved' ? `Rp ${(deposit.amount - (deposit.adminFee || 0)).toLocaleString('id-ID')}` : '-'}
                                            </td>
                                            <td className="whitespace-nowrap px-6 py-4">
                                                <span className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold ${statusMeta.className}`}>
                                                    <StatusIcon className="h-3 w-3" />
                                                    {statusMeta.label}
                                                </span>
                                            </td>
                                            <td className="whitespace-nowrap px-6 py-4">
                                                <button
                                                    onClick={() => setSelectedDeposit(deposit)}
                                                    className="rounded-xl border border-[#3a3a5a] bg-[#252540] p-2 text-orange-400 transition hover:bg-[#3a3a5a]/80 hover:text-orange-300"
                                                    title="Lihat Detail"
                                                >
                                                    <Eye className="h-4 w-4" />
                                                </button>
                                            </td>
                                        </tr>
                                    );
                                })
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {selectedDeposit && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
                    <div className="w-full max-w-md overflow-hidden rounded-[30px] border border-[#3a3a5a] bg-[#1a1a2e] shadow-2xl">
                        <div className="flex items-center justify-between border-b border-[#3a3a5a] bg-[#252540]/50 px-5 py-4">
                            <div>
                                <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-gray-500">Detail Deposit</p>
                                <h2 className="mt-1 text-lg font-bold text-white">Ringkasan transaksi</h2>
                            </div>
                            <button onClick={() => setSelectedDeposit(null)} className="text-gray-400 transition hover:text-white">
                                <X className="h-5 w-5" />
                            </button>
                        </div>
                        <div className="space-y-4 p-5">
                            {(() => {
                                const statusMeta = depositStatusConfig[selectedDeposit.status];
                                const StatusIcon = statusMeta.icon;

                                return (
                                    <div className="flex justify-center">
                                        <span className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold ${statusMeta.className}`}>
                                            <StatusIcon className="h-4 w-4" />
                                            {statusMeta.label}
                                        </span>
                                    </div>
                                );
                            })()}

                            <div className="space-y-3 rounded-[24px] border border-[#3a3a5a] bg-[#252540] p-4">
                                <div className="flex justify-between gap-4">
                                    <span className="text-sm text-gray-400">ID Deposit</span>
                                    <span className="text-sm font-mono text-gray-300">DEP-{selectedDeposit._id.slice(-8).toUpperCase()}</span>
                                </div>
                                <div className="flex justify-between gap-4">
                                    <span className="text-sm text-gray-400">Tanggal</span>
                                    <span className="text-right text-sm text-white">{new Date(selectedDeposit.createdAt).toLocaleString('id-ID')}</span>
                                </div>
                                {selectedDeposit.paymentMethod && (
                                    <>
                                        <hr className="border-[#3a3a5a]" />
                                        <div className="flex justify-between gap-4">
                                            <span className="text-sm text-gray-400">Bank</span>
                                            <span className="text-right text-sm font-semibold text-white">{selectedDeposit.paymentMethod.name}</span>
                                        </div>
                                        <div className="flex justify-between gap-4">
                                            <span className="text-sm text-gray-400">No. Rekening</span>
                                            <span className="text-right text-sm font-mono text-white">{selectedDeposit.paymentMethod.accountNumber}</span>
                                        </div>
                                        <div className="flex justify-between gap-4">
                                            <span className="text-sm text-gray-400">Atas Nama</span>
                                            <span className="text-right text-sm text-white">{selectedDeposit.paymentMethod.accountName}</span>
                                        </div>
                                    </>
                                )}
                                <hr className="border-[#3a3a5a]" />
                                <div className="flex justify-between gap-4">
                                    <span className="text-sm text-gray-400">Nominal Deposit</span>
                                    <span className="text-sm font-semibold text-white">Rp {selectedDeposit.amount.toLocaleString('id-ID')}</span>
                                </div>
                                <div className="flex justify-between gap-4">
                                    <span className="text-sm text-gray-400">Kode Unik</span>
                                    <span className="text-sm font-semibold text-emerald-400">+{selectedDeposit.uniqueCode || 0}</span>
                                </div>
                                <div className="flex justify-between gap-4">
                                    <span className="text-sm text-gray-400">Total Transfer</span>
                                    <span className="text-sm font-bold text-orange-500">Rp {(selectedDeposit.totalAmount || selectedDeposit.amount).toLocaleString('id-ID')}</span>
                                </div>
                                {(selectedDeposit.adminFee || 0) > 0 && (
                                    <>
                                        <hr className="border-[#3a3a5a]" />
                                        <div className="flex justify-between gap-4">
                                            <span className="text-sm text-gray-400">Biaya Admin</span>
                                            <span className="text-sm font-semibold text-rose-400">-Rp {(selectedDeposit.adminFee || 0).toLocaleString('id-ID')}</span>
                                        </div>
                                        <div className="flex justify-between gap-4 rounded-[18px] bg-[#1a1a2e] p-3 border border-[#3a3a5a]">
                                            <span className="text-sm font-medium text-gray-300">Saldo Diterima</span>
                                            <span className="text-sm font-bold text-emerald-400">
                                                Rp {(selectedDeposit.amount - (selectedDeposit.adminFee || 0)).toLocaleString('id-ID')}
                                            </span>
                                        </div>
                                    </>
                                )}
                            </div>

                            <button
                                onClick={() => setSelectedDeposit(null)}
                                className="w-full rounded-2xl border border-[#3a3a5a] bg-[#252540] px-4 py-3 text-sm font-semibold text-gray-300 transition-colors hover:bg-orange-500 hover:border-orange-500 hover:text-white"
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
