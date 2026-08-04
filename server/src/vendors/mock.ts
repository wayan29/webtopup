import { IVendorAdapter } from './types';

type MockVendorStatus = 'pending' | 'success' | 'failed';

const normalizeStatus = (value: unknown, fallback: MockVendorStatus): MockVendorStatus => {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (normalized === 'success' || normalized === 'failed' || normalized === 'pending') {
        return normalized;
    }
    return fallback;
};

const normalizeOptionalText = (value: unknown) => (
    typeof value === 'string' ? value.trim() : ''
);

const statusFromScenarioText = (value: unknown): MockVendorStatus | null => {
    const text = typeof value === 'string' ? value.toLowerCase() : '';
    if (text.includes('mock-status-success')) return 'success';
    if (text.includes('mock-status-failed')) return 'failed';
    if (text.includes('mock-status-pending')) return 'pending';
    return null;
};

export class MockVendorAdapter implements IVendorAdapter {
    async getBalance(): Promise<number> {
        const balance = Number(process.env.PROVIDER_MOCK_BALANCE);
        return Number.isFinite(balance) && balance >= 0 ? balance : 0;
    }

    async getPriceList(): Promise<any[]> {
        return [];
    }

    async topUp(trxId: string, _productCode: string, target: string): Promise<{
        status: MockVendorStatus;
        vendorTrxId?: string;
        message?: string;
        sn?: string;
    }> {
        if (typeof target === 'string' && target.toLowerCase().includes('mock-status-error')) {
            throw new Error('Mock top-up error');
        }

        const status = statusFromScenarioText(target)
            || normalizeStatus(process.env.PROVIDER_MOCK_TOPUP_STATUS, 'pending');
        const sn = normalizeOptionalText(process.env.PROVIDER_MOCK_SN);

        return {
            status,
            vendorTrxId: normalizeOptionalText(process.env.PROVIDER_MOCK_VENDOR_TRX_ID) || trxId,
            message: normalizeOptionalText(process.env.PROVIDER_MOCK_MESSAGE) || `Mock top-up ${status}`,
            sn: status === 'success' && sn ? sn : undefined
        };
    }

    async checkStatus(_trxId: string, _vendorTrxId?: string, productCode?: string, target?: string): Promise<{
        status: MockVendorStatus;
        sn?: string;
        message?: string;
    }> {
        const status = statusFromScenarioText(productCode)
            || statusFromScenarioText(target)
            || normalizeStatus(process.env.PROVIDER_MOCK_RECHECK_STATUS, 'pending');
        const sn = normalizeOptionalText(process.env.PROVIDER_MOCK_SN);

        return {
            status,
            message: normalizeOptionalText(process.env.PROVIDER_MOCK_MESSAGE) || `Mock status ${status}`,
            sn: status === 'success' && sn ? sn : undefined
        };
    }
}
