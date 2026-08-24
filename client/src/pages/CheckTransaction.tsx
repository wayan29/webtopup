import { useEffect, useState } from 'react';
import { useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import { 
    ArrowLeft, 
    Loader2, 
    Search,
    Clock,
    CheckCircle,
    XCircle,
    AlertCircle,
    Copy,
    RefreshCw
} from 'lucide-react';
import { apiV2 } from '../api';

interface GuestTransaction {
    _id: string;
    invoiceNumber: string;
    product: {
        name: string;
        code: string;
    };
    target: string;
    serverId?: string;
    whatsapp: string;
    amount: number;
    adminFee: number;
    uniqueCode: number;
    totalAmount: number;
    paymentMethod: {
        name: string;
        accountNumber: string;
        accountName: string;
    };
    paymentStatus: 'waiting_payment' | 'paid' | 'expired' | 'cancelled';
    transactionStatus: 'pending' | 'processing' | 'success' | 'failed';
    sn?: string;
    expiredAt: string;
    createdAt: string;
}

export default function CheckTransaction() {
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();
    const location = useLocation();
    const invoiceFromUrl = searchParams.get('invoice') || '';
    const whatsappFromUrl = searchParams.get('whatsapp') || '';

    const [invoice, setInvoice] = useState(invoiceFromUrl);
    const [whatsapp, setWhatsapp] = useState(whatsappFromUrl);
    const [transaction, setTransaction] = useState<GuestTransaction | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [_copied, setCopied] = useState(false);
    const isEmbeddedInDashboard = location.pathname.startsWith('/dashboard/');

    const fetchTransaction = async (inv: string, phone?: string) => {
        if (!inv) return;
        if (!isEmbeddedInDashboard && !phone) return;

        setLoading(true);
        setError('');
        try {
            const params = isEmbeddedInDashboard ? undefined : phone ? { whatsapp: phone } : undefined;
            const res = await apiV2.get(`/guest-transactions/check/${inv}`, { params });
            setTransaction(res.data);
        } catch (err: any) {
            setError(err.response?.data?.message || 'Transaksi tidak ditemukan');
            setTransaction(null);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (isEmbeddedInDashboard) {
            if (invoiceFromUrl) {
                void fetchTransaction(invoiceFromUrl);
            }
            return;
        }
        if (invoiceFromUrl && whatsappFromUrl) {
            void fetchTransaction(invoiceFromUrl, whatsappFromUrl);
        }
    }, [invoiceFromUrl, whatsappFromUrl, isEmbeddedInDashboard]);

    const handleSearch = (e: React.FormEvent) => {
        e.preventDefault();
        const trimmedInvoice = invoice.trim().toUpperCase();
        const trimmedWhatsapp = whatsapp.trim();
        if (!trimmedInvoice) {
            return;
        }
        if (isEmbeddedInDashboard) {
            navigate(`/dashboard/check-transaction?invoice=${encodeURIComponent(trimmedInvoice)}`);
            void fetchTransaction(trimmedInvoice);
            return;
        }
        if (!trimmedWhatsapp) {
            return;
        }

        navigate(
            `/check-transaction?invoice=${encodeURIComponent(trimmedInvoice)}&whatsapp=${encodeURIComponent(trimmedWhatsapp)}`
        );
        void fetchTransaction(trimmedInvoice, trimmedWhatsapp);
    };

    const handleCopy = (text: string) => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const handleBack = () => {
        if (isEmbeddedInDashboard) {
            navigate('/dashboard');
            return;
        }

        navigate(-1);
    };

    const formatPrice = (price: number) => {
        return new Intl.NumberFormat('id-ID').format(price);
    };

    const getPaymentStatusBadge = (status: string) => {
        switch (status) {
            case 'waiting_payment':
                return (
                    <span className="px-3 py-1 bg-yellow-500/20 text-yellow-400 text-sm font-medium rounded-full flex items-center gap-1">
                        <Clock className="w-4 h-4" /> Menunggu Pembayaran
                    </span>
                );
            case 'paid':
                return (
                    <span className="px-3 py-1 bg-green-500/20 text-green-400 text-sm font-medium rounded-full flex items-center gap-1">
                        <CheckCircle className="w-4 h-4" /> Sudah Dibayar
                    </span>
                );
            case 'expired':
                return (
                    <span className="ui-muted-action flex items-center gap-1 rounded-full px-3 py-1 text-sm font-medium">
                        <XCircle className="w-4 h-4" /> Kadaluarsa
                    </span>
                );
            case 'cancelled':
                return (
                    <span className="px-3 py-1 bg-red-500/20 text-red-400 text-sm font-medium rounded-full flex items-center gap-1">
                        <XCircle className="w-4 h-4" /> Dibatalkan
                    </span>
                );
            default:
                return null;
        }
    };

    const getTransactionStatusBadge = (status: string) => {
        switch (status) {
            case 'pending':
                return <span className="px-2 py-1 bg-yellow-500/20 text-yellow-400 text-xs rounded">Pending</span>;
            case 'processing':
                return <span className="px-2 py-1 bg-blue-500/20 text-blue-400 text-xs rounded">Diproses</span>;
            case 'success':
                return <span className="px-2 py-1 bg-green-500/20 text-green-400 text-xs rounded">Sukses</span>;
            case 'failed':
                return <span className="px-2 py-1 bg-red-500/20 text-red-400 text-xs rounded">Gagal</span>;
            default:
                return null;
        }
    };

    return (
        <div className={`${isEmbeddedInDashboard ? '' : 'ui-shell min-h-screen'} ui-text`}>
            {/* Header */}
            <div className={`ui-panel ui-border border-b ${isEmbeddedInDashboard ? 'rounded-2xl' : 'sticky top-0 z-10'}`}>
                <div className="max-w-3xl mx-auto px-4 py-4 flex items-center gap-4">
                    <button 
                        onClick={handleBack}
                        className="ui-muted-action flex h-10 w-10 items-center justify-center rounded-full p-0"
                    >
                        <ArrowLeft className="w-5 h-5" />
                    </button>
                    <h1 className="ui-text font-semibold">Cek Transaksi</h1>
                </div>
            </div>

            <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
                {/* Search Form */}
                <form onSubmit={handleSearch} className="ui-panel ui-border rounded-2xl border p-4">
                    <div className={`grid grid-cols-1 gap-2 ${isEmbeddedInDashboard ? 'md:grid-cols-[1fr_auto]' : 'md:grid-cols-[1fr_1fr_auto]'}`}>
                        <div>
                            <label className="ui-text-muted mb-2 block text-sm">Nomor Invoice</label>
                            <input
                                type="text"
                                value={invoice}
                                onChange={(e) => setInvoice(e.target.value.toUpperCase())}
                                placeholder="Masukkan nomor invoice"
                                className="ui-field w-full rounded-xl px-4 py-3"
                            />
                        </div>
                        {!isEmbeddedInDashboard && (
                            <div>
                                <label className="ui-text-muted mb-2 block text-sm">Nomor WhatsApp</label>
                                <input
                                    type="text"
                                    value={whatsapp}
                                    onChange={(e) => setWhatsapp(e.target.value)}
                                    placeholder="Nomor yang dipakai saat checkout"
                                    className="ui-field w-full rounded-xl px-4 py-3"
                                />
                            </div>
                        )}
                        <button 
                            type="submit"
                            disabled={loading || !invoice || (!isEmbeddedInDashboard && !whatsapp)}
                            className="ui-accent-solid flex items-center justify-center gap-2 self-end rounded-xl px-4 py-3 font-medium transition hover:brightness-105 disabled:opacity-50"
                        >
                            {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Search className="w-5 h-5" />}
                        </button>
                    </div>
                    <p className="ui-text-muted mt-2 text-xs">
                        {isEmbeddedInDashboard
                            ? 'Akun login cukup memakai nomor invoice untuk cek transaksi guest yang terikat ke akun ini.'
                            : 'Untuk keamanan, cek transaksi publik membutuhkan invoice dan nomor WhatsApp yang dipakai saat checkout.'}
                    </p>
                </form>

                {/* Error */}
                {error && (
                    <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 flex items-center gap-3">
                        <AlertCircle className="w-5 h-5 text-red-400" />
                        <span className="text-red-400">{error}</span>
                    </div>
                )}

                {/* Transaction Details */}
                {transaction && (
                    <div className="space-y-4">
                        {/* Status */}
                        <div className="ui-panel ui-border rounded-2xl border p-4">
                            <div className="flex items-center justify-between">
                                <h2 className="font-semibold">Status Pembayaran</h2>
                                {getPaymentStatusBadge(transaction.paymentStatus)}
                            </div>
                            {transaction.paymentStatus === 'waiting_payment' && (
                                <p className="ui-text-muted mt-2 text-sm">
                                    Bayar sebelum: {new Date(transaction.expiredAt).toLocaleString('id-ID')}
                                </p>
                            )}
                        </div>

                        {/* Invoice Info */}
                        <div className="ui-panel ui-border rounded-2xl border p-4">
                            <div className="flex items-center justify-between mb-4">
                                <h2 className="font-semibold">Detail Transaksi</h2>
                                <button 
                                    onClick={() => fetchTransaction(invoice, whatsapp)}
                                    className="ui-muted-action rounded-lg p-2"
                                    title="Refresh"
                                >
                                    <RefreshCw className="ui-text-muted h-4 w-4" />
                                </button>
                            </div>
                            <div className="space-y-3">
                                <div className="flex justify-between">
                                    <span className="ui-text-muted text-sm">Invoice</span>
                                    <span className="ui-accent-text font-medium">{transaction.invoiceNumber}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="ui-text-muted text-sm">Produk</span>
                                    <span className="text-sm">{transaction.product.name}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-sm ui-text-muted">Tujuan</span>
                                    <span>{transaction.target}</span>
                                </div>
                                {transaction.serverId && (
                                    <div className="flex justify-between">
                                        <span className="text-sm ui-text-muted">Server ID</span>
                                        <span>{transaction.serverId}</span>
                                    </div>
                                )}
                                <div className="flex justify-between">
                                    <span className="text-sm ui-text-muted">Status Transaksi</span>
                                    {getTransactionStatusBadge(transaction.transactionStatus)}
                                </div>
                                {transaction.sn && (
                                    <div className="flex justify-between items-center">
                                        <span className="text-sm ui-text-muted">SN/Token</span>
                                        <div className="flex items-center gap-2">
                                            <span className="font-mono text-green-400">{transaction.sn}</span>
                                            <button 
                                                onClick={() => handleCopy(transaction.sn!)}
                                                className="p-1 hover:bg-[var(--ui-card-muted)] rounded"
                                            >
                                                <Copy className="w-4 h-4 ui-text-muted" />
                                            </button>
                                        </div>
                                    </div>
                                )}
                                <div className="flex justify-between">
                                    <span className="text-sm ui-text-muted">Tanggal</span>
                                    <span className="text-sm">{new Date(transaction.createdAt).toLocaleString('id-ID')}</span>
                                </div>
                            </div>
                        </div>

                        {/* Payment Info - only show if waiting payment */}
                        {transaction.paymentStatus === 'waiting_payment' && (
                            <div className="ui-panel ui-border rounded-2xl border p-4">
                                <h2 className="font-semibold mb-4">Informasi Pembayaran</h2>
                                <div className="space-y-3">
                                    <div className="flex justify-between">
                                        <span className="text-sm ui-text-muted">Bank</span>
                                        <span>{transaction.paymentMethod.name}</span>
                                    </div>
                                    <div className="flex justify-between items-center">
                                        <span className="text-sm ui-text-muted">No. Rekening</span>
                                        <div className="flex items-center gap-2">
                                            <span className="font-medium">{transaction.paymentMethod.accountNumber}</span>
                                            <button 
                                                onClick={() => handleCopy(transaction.paymentMethod.accountNumber)}
                                                className="p-1 hover:bg-[var(--ui-card-muted)] rounded"
                                            >
                                                <Copy className="w-4 h-4 ui-text-muted" />
                                            </button>
                                        </div>
                                    </div>
                                    <div className="flex justify-between">
                                        <span className="text-sm ui-text-muted">Atas Nama</span>
                                        <span>{transaction.paymentMethod.accountName}</span>
                                    </div>
                                    <div className="border-t ui-border pt-3">
                                        <div className="flex justify-between">
                                            <span className="text-sm ui-text-muted">Harga</span>
                                            <span>Rp {formatPrice(transaction.amount)}</span>
                                        </div>
                                        <div className="flex justify-between mt-2">
                                            <span className="text-sm ui-text-muted">Biaya Admin</span>
                                            <span>Rp {formatPrice(transaction.adminFee)}</span>
                                        </div>
                                        <div className="flex justify-between mt-2">
                                            <span className="text-sm ui-text-muted">Kode Unik</span>
                                            <span className="ui-accent-text">{transaction.uniqueCode}</span>
                                        </div>
                                        <div className="flex justify-between mt-3 pt-3 border-t ui-border">
                                            <span className="font-medium">Total Transfer</span>
                                            <div className="flex items-center gap-2">
                                                <span className="text-xl font-bold ui-accent-text">Rp {formatPrice(transaction.totalAmount)}</span>
                                                <button 
                                                    onClick={() => handleCopy(transaction.totalAmount.toString())}
                                                    className="p-1 hover:bg-[var(--ui-card-muted)] rounded"
                                                >
                                                    <Copy className="w-4 h-4 ui-text-muted" />
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Notes */}
                        {transaction.paymentStatus === 'waiting_payment' && (
                            <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4">
                                <p className="text-sm text-yellow-400 font-medium mb-2">Penting!</p>
                                <ul className="space-y-1 text-xs ui-text-muted">
                                    <li>• Transfer sesuai nominal termasuk kode unik</li>
                                    <li>• Transaksi akan diproses setelah pembayaran dikonfirmasi admin</li>
                                    <li>• Hubungi admin jika pembayaran sudah dilakukan</li>
                                </ul>
                            </div>
                        )}
                    </div>
                )}

                {/* Empty State */}
                {!loading && !transaction && !error && !invoiceFromUrl && !whatsappFromUrl && (
                    <div className="text-center py-12">
                        <Search className="ui-text-muted mx-auto mb-4 h-16 w-16 opacity-60" />
                        <p className="ui-text-muted">Masukkan invoice dan WhatsApp untuk melihat status transaksi</p>
                    </div>
                )}
            </div>
        </div>
    );
}
