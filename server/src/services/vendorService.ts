import { IVendorAdapter } from '../vendors/types';
import { DigiflazzAdapter } from '../vendors/digiflazz';
import { TokovoucherAdapter } from '../vendors/tokovoucher';
import { MockVendorAdapter } from '../vendors/mock';
import Vendor from '../models/Vendor';

const getProviderMode = () => (process.env.PROVIDER_MODE || 'live').trim().toLowerCase();

const requireSandboxBaseUrl = (key: string) => {
    const value = process.env[key]?.trim();
    if (!value) {
        throw new Error(`${key} is required when PROVIDER_MODE=sandbox`);
    }
    return value.replace(/\/+$/, '');
};

class VendorService {
    private async getAdapter(vendorName?: string): Promise<IVendorAdapter> {
        if (getProviderMode() === 'mock') {
            return new MockVendorAdapter();
        }

        // Try DB vendor config first
        const vendor = vendorName ? await Vendor.findOne({ name: new RegExp(`^${vendorName}$`, 'i') }) : null;
        const normalized = vendorName?.toLowerCase() || vendor?.name?.toLowerCase() || '';

        if (normalized.includes('tokovoucher')) {
            const memberCode =
                vendor?.config?.memberCode ||
                vendor?.config?.apiKey ||
                process.env.TOKOVOUCHER_MEMBER_CODE ||
                process.env.TOKOVOUCHER_API_KEY ||
                '';
            const secret = vendor?.config?.secret || process.env.TOKOVOUCHER_SECRET || '';
            const baseUrl = getProviderMode() === 'sandbox'
                ? requireSandboxBaseUrl('PROVIDER_SANDBOX_TOKOVOUCHER_BASE_URL')
                : vendor?.apiBaseUrl || process.env.TOKOVOUCHER_BASE_URL || 'https://api.tokovoucher.net/v1';
            return new TokovoucherAdapter(memberCode, secret, baseUrl);
        }

        // Default to Digiflazz
        const username = vendor?.config?.username || process.env.DIGIFLAZZ_USERNAME || 'demo';
        const apiKey = vendor?.config?.apiKey || process.env.DIGIFLAZZ_API_KEY || 'dev';
        const baseUrl = getProviderMode() === 'sandbox'
            ? requireSandboxBaseUrl('PROVIDER_SANDBOX_DIGIFLAZZ_BASE_URL')
            : vendor?.apiBaseUrl || process.env.DIGIFLAZZ_BASE_URL || 'https://api.digiflazz.com/v1';
        return new DigiflazzAdapter(username, apiKey, baseUrl);
    }

    async topUp(
        trxId: string,
        productCode: string,
        target: string,
        vendorName?: string,
        serverId?: string
    ) {
        const adapter = await this.getAdapter(vendorName);
        return adapter.topUp(trxId, productCode, target, serverId);
    }

    async getBalance(vendorName?: string) {
        const adapter = await this.getAdapter(vendorName);
        return adapter.getBalance();
    }

    async checkStatus(trxId: string, vendorTrxId?: string, vendorName?: string, productCode?: string, target?: string) {
        const adapter = await this.getAdapter(vendorName);
        return adapter.checkStatus(trxId, vendorTrxId, productCode, target);
    }
}

export default new VendorService();
