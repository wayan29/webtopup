import type {
    DashboardBalanceHistoryItem,
    DashboardDeposit,
    DashboardTransaction
} from '../pages/dashboard/types';

export const buildLegacyBalanceHistory = (
    transactions: DashboardTransaction[],
    deposits: DashboardDeposit[]
): DashboardBalanceHistoryItem[] => {
    const depositItems: DashboardBalanceHistoryItem[] = deposits
        .filter((deposit) => deposit.status === 'approved')
        .map((deposit) => ({
            _id: `deposit-${deposit._id}`,
            source: 'deposit',
            type: 'credit',
            amount: Math.max(0, deposit.amount - (deposit.adminFee || 0)),
            description: 'Deposit disetujui',
            reference: deposit._id,
            createdAt: deposit.createdAt
        }));

    const balancePurchaseItems: DashboardBalanceHistoryItem[] = transactions
        .filter((transaction) => transaction.status === 'success' && transaction.source !== 'payment_gateway')
        .map((transaction) => ({
            _id: `transaction-${transaction._id}`,
            source: 'purchase',
            type: 'debit',
            amount: transaction.amount,
            description: `Pembelian ${transaction.product?.name || 'produk'}`,
            reference: transaction.invoiceNumber || transaction._id,
            createdAt: transaction.createdAt
        }));

    return [...depositItems, ...balancePurchaseItems].sort(
        (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
    );
};
