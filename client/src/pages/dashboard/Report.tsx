import { useOutletContext } from 'react-router-dom';
import { Activity, CheckCircle, Loader2, TrendingDown, TrendingUp } from 'lucide-react';
import { useAuthStore } from '../../store/useAuthStore';
import type { DashboardOutletContext } from './types';

export default function DashboardReport() {
    const { user } = useAuthStore();
    const { transactions, deposits, loading, error } = useOutletContext<DashboardOutletContext>();
    const shouldShowBalance = user?.preferences?.showBalance !== false;
    const balanceText = shouldShowBalance
        ? `Rp ${user?.balance?.toLocaleString('id-ID') || '0'}`
        : 'Rp ••••••';

    const now = new Date();
    const thisMonth = now.getMonth();
    const thisYear = now.getFullYear();

    const approvedDeposits = deposits.filter((deposit) => deposit.status === 'approved');
    const successfulTransactions = transactions.filter((transaction) => transaction.status === 'success');
    const successfulBalanceTransactions = successfulTransactions.filter((transaction) => transaction.source !== 'payment_gateway');
    const successfulGatewayTransactions = successfulTransactions.filter((transaction) => transaction.source === 'payment_gateway');

    const totalDeposit = approvedDeposits.reduce((sum, deposit) => sum + (deposit.amount - (deposit.adminFee || 0)), 0);
    const totalBalancePurchases = successfulBalanceTransactions.reduce((sum, transaction) => sum + transaction.amount, 0);
    const totalGatewayPurchases = successfulGatewayTransactions.reduce((sum, transaction) => sum + transaction.amount, 0);
    const totalPurchaseValue = totalBalancePurchases + totalGatewayPurchases;

    const thisMonthDeposits = approvedDeposits.filter((deposit) => {
        const date = new Date(deposit.createdAt);
        return date.getMonth() === thisMonth && date.getFullYear() === thisYear;
    });

    const thisMonthBalanceTransactions = successfulBalanceTransactions.filter((transaction) => {
        const date = new Date(transaction.createdAt);
        return date.getMonth() === thisMonth && date.getFullYear() === thisYear;
    });

    const thisMonthGatewayTransactions = successfulGatewayTransactions.filter((transaction) => {
        const date = new Date(transaction.createdAt);
        return date.getMonth() === thisMonth && date.getFullYear() === thisYear;
    });

    const thisMonthDeposit = thisMonthDeposits.reduce((sum, deposit) => sum + (deposit.amount - (deposit.adminFee || 0)), 0);
    const thisMonthBalancePurchase = thisMonthBalanceTransactions.reduce((sum, transaction) => sum + transaction.amount, 0);
    const thisMonthGatewayPurchase = thisMonthGatewayTransactions.reduce((sum, transaction) => sum + transaction.amount, 0);

    if (loading) {
        return (
            <div className="flex items-center justify-center py-20">
                <Loader2 className="w-8 h-8 animate-spin text-orange-500" />
            </div>
        );
    }

    const successRate = transactions.length > 0
        ? Math.round((successfulTransactions.length / transactions.length) * 100)
        : 0;

    return (
        <>
            <div className="rounded-[28px] border border-[#3a3a5a] bg-[#1a1a2e] p-5">
                <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-gray-500">Member Report</p>
                <h1 className="mt-2 text-3xl font-black text-white">Laporan</h1>
                <p className="mt-2 text-sm leading-7 text-gray-400">Ringkasan aktivitas akun dan breakdown pembelian per metode pembayaran.</p>
            </div>

            {error && (
                <div className="rounded-[24px] border border-orange-500/20 bg-orange-500/10 px-4 py-3 text-sm text-orange-400">
                    Sebagian data laporan masih memakai cache halaman ini karena sinkronisasi terakhir gagal.
                </div>
            )}

            <div className="rounded-[28px] bg-gradient-to-r from-orange-500 to-amber-600 p-6 text-white shadow-xl shadow-orange-500/10">
                <p className="text-sm text-white/80 font-medium">Saldo Saat Ini</p>
                <p className="mt-2 text-4xl font-black tracking-tight">{balanceText}</p>
            </div>

            <div>
                <h3 className="mb-3 text-base font-semibold text-white">Statistik Keseluruhan</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                    <div className="rounded-[24px] border border-[#3a3a5a] bg-[#1a1a2e] p-5">
                        <div className="flex items-center gap-3 mb-3">
                            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-emerald-500/20 border border-emerald-500/30">
                                <TrendingUp className="w-5 h-5 text-emerald-400" />
                            </div>
                            <p className="text-sm font-medium text-gray-400">Total Deposit</p>
                        </div>
                        <p className="text-2xl font-black text-emerald-400">Rp {totalDeposit.toLocaleString('id-ID')}</p>
                    </div>

                    <div className="rounded-[24px] border border-[#3a3a5a] bg-[#1a1a2e] p-5">
                        <div className="flex items-center gap-3 mb-3">
                            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-rose-500/20 border border-rose-500/30">
                                <TrendingDown className="w-5 h-5 text-rose-400" />
                            </div>
                            <p className="text-sm font-medium text-gray-400">Total Pembelian</p>
                        </div>
                        <p className="text-2xl font-black text-rose-400">Rp {totalPurchaseValue.toLocaleString('id-ID')}</p>
                        <p className="mt-1 text-xs text-gray-500">
                            Saldo Rp {totalBalancePurchases.toLocaleString('id-ID')} • Gateway Rp {totalGatewayPurchases.toLocaleString('id-ID')}
                        </p>
                    </div>

                    <div className="rounded-[24px] border border-[#3a3a5a] bg-[#1a1a2e] p-5">
                        <div className="flex items-center gap-3 mb-3">
                            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-sky-500/20 border border-sky-500/30">
                                <Activity className="w-5 h-5 text-sky-400" />
                            </div>
                            <p className="text-sm font-medium text-gray-400">Total Order</p>
                        </div>
                        <p className="text-2xl font-black text-white">{transactions.length}</p>
                    </div>

                    <div className="rounded-[24px] border border-[#3a3a5a] bg-[#252540] p-5">
                        <div className="flex items-center gap-3 mb-3">
                            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[#1a1a2e] border border-[#3a3a5a]">
                                <CheckCircle className="w-5 h-5 text-[#6b86a3]" />
                            </div>
                            <p className="text-sm font-medium text-[#6b86a3]">Tingkat Sukses</p>
                        </div>
                        <p className="text-2xl font-black text-white">{successRate}%</p>
                        <p className="mt-1 text-xs text-gray-500">{successfulTransactions.length} dari {transactions.length} order</p>
                    </div>
                </div>
            </div>

            <div>
                <h3 className="mb-3 text-base font-semibold text-white">Statistik Bulan Ini</h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="rounded-[24px] border border-[#3a3a5a] bg-[#1a1a2e] p-5">
                        <p className="mb-2 text-sm font-medium text-gray-400">Deposit Bulan Ini</p>
                        <p className="text-2xl font-black text-emerald-400">Rp {thisMonthDeposit.toLocaleString('id-ID')}</p>
                    </div>

                    <div className="rounded-[24px] border border-[#3a3a5a] bg-[#1a1a2e] p-5">
                        <p className="mb-2 text-sm font-medium text-gray-400">Pembelian Bulan Ini</p>
                        <p className="text-2xl font-black text-rose-400">Rp {(thisMonthBalancePurchase + thisMonthGatewayPurchase).toLocaleString('id-ID')}</p>
                        <p className="mt-1 text-xs text-gray-500">
                            Saldo Rp {thisMonthBalancePurchase.toLocaleString('id-ID')} • Gateway Rp {thisMonthGatewayPurchase.toLocaleString('id-ID')}
                        </p>
                    </div>

                    <div className="rounded-[24px] border border-[#3a3a5a] bg-[#252540] p-5">
                        <p className="mb-2 text-sm font-medium text-[#6b86a3]">Order Sukses Bulan Ini</p>
                        <p className="text-2xl font-black text-white">{thisMonthBalanceTransactions.length + thisMonthGatewayTransactions.length}</p>
                    </div>
                </div>
            </div>

            <div className="rounded-[28px] border border-[#3a3a5a] bg-[#1a1a2e] p-5">
                <h3 className="mb-4 text-base font-semibold text-white">Ringkasan</h3>
                <div className="space-y-3">
                    <div className="flex items-center justify-between border-b border-[#3a3a5a] py-2">
                        <span className="text-gray-400">Total Deposit</span>
                        <span className="font-semibold text-emerald-400">+ Rp {totalDeposit.toLocaleString('id-ID')}</span>
                    </div>
                    <div className="flex items-center justify-between border-b border-[#3a3a5a] py-2">
                        <span className="text-gray-400">Pembelian via Saldo</span>
                        <span className="font-semibold text-rose-400">- Rp {totalBalancePurchases.toLocaleString('id-ID')}</span>
                    </div>
                    <div className="flex items-center justify-between border-b border-[#3a3a5a] py-2">
                        <span className="text-gray-400">Pembayaran via Gateway</span>
                        <span className="font-semibold text-[#6b86a3]">Rp {totalGatewayPurchases.toLocaleString('id-ID')}</span>
                    </div>
                    <div className="flex items-center justify-between py-2">
                        <span className="font-semibold text-white">Saldo Saat Ini</span>
                        <span className="text-lg font-bold text-orange-400">{balanceText}</span>
                    </div>
                </div>
            </div>
        </>
    );
}
