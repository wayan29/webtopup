export type DashboardTransactionSource = 'balance' | 'payment_gateway';
export type DashboardTransactionStatus = 'pending' | 'processing' | 'success' | 'failed';
export type DashboardPaymentStatus = 'waiting_payment' | 'paid' | 'expired' | 'cancelled';

export interface DashboardTransaction {
    _id: string;
    invoiceNumber?: string;
    vendorTrxId?: string;
    product?: {
        _id?: string;
        name?: string;
        code?: string;
        category?: string;
        brand?: string;
    };
    target: string;
    amount: number;
    status: DashboardTransactionStatus | string;
    paymentStatus?: DashboardPaymentStatus | string;
    source?: DashboardTransactionSource;
    sn?: string;
    message?: string;
    createdAt: string;
    updatedAt?: string;
}

export interface DashboardDeposit {
    _id: string;
    amount: number;
    uniqueCode?: number;
    adminFee?: number;
    totalAmount?: number;
    status: 'pending' | 'approved' | 'rejected' | string;
    createdAt: string;
}

export interface DashboardBalanceHistoryItem {
    _id: string;
    source: 'deposit' | 'purchase' | 'voucher' | 'adjustment';
    type: 'credit' | 'debit';
    amount: number;
    description: string;
    reference: string;
    createdAt: string;
    balanceBefore?: number;
    balanceAfter?: number;
    meta?: Record<string, unknown>;
}

export interface DashboardOutletContext {
    transactions: DashboardTransaction[];
    deposits: DashboardDeposit[];
    balanceHistory: DashboardBalanceHistoryItem[];
    loading: boolean;
    refreshing: boolean;
    error: string | null;
    lastUpdatedAt: number | null;
    refreshData: () => Promise<void>;
}
