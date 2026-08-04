import axios from 'axios';
import crypto from 'crypto';
import { IVendorAdapter } from './types';

type DigiflazzStatus = 'pending' | 'success' | 'failed';

const mapDigiflazzStatus = (raw?: string): DigiflazzStatus => {
    const normalized = (raw || '').toLowerCase();
    if (normalized.includes('sukses') || normalized.includes('success')) return 'success';
    if (normalized.includes('gagal') || normalized.includes('failed')) return 'failed';
    return 'pending';
};

const buildDigiflazzMessage = (data: any, fallback?: string) => (
    data?.message || data?.rc || fallback || 'Status check completed'
);

export class DigiflazzAdapter implements IVendorAdapter {
    private username: string;
    private apiKey: string;
    private baseUrl: string;

    constructor(username: string, apiKey: string, baseUrl: string = 'https://api.digiflazz.com/v1') {
        this.username = username;
        this.apiKey = apiKey;
        this.baseUrl = baseUrl;
    }

    private sign(refId: string): string {
        return crypto.createHash('md5').update(this.username + this.apiKey + refId).digest('hex');
    }

    async getBalance(): Promise<number> {
        try {
            const res = await axios.post(`${this.baseUrl}/cek-saldo`, {
                cmd: 'deposit',
                username: this.username,
                sign: crypto.createHash('md5').update(this.username + this.apiKey + 'depo').digest('hex')
            });
            return (res.data as any).data.deposit;
        } catch (error) {
            console.error('Digiflazz getBalance error:', error);
            return 0;
        }
    }

    async getPriceList(): Promise<any[]> {
        try {
            const res = await axios.post(`${this.baseUrl}/price-list`, {
                cmd: 'prepaid',
                username: this.username,
                sign: crypto.createHash('md5').update(this.username + this.apiKey + 'pricelist').digest('hex')
            });
            return (res.data as any).data;
        } catch (error) {
            console.error('Digiflazz getPriceList error:', error);
            return [];
        }
    }

    async topUp(trxId: string, productCode: string, target: string, _serverId?: string): Promise<{ status: 'pending' | 'success' | 'failed'; vendorTrxId?: string; message?: string; sn?: string; }> {
        try {
            const sign = this.sign(trxId);
            const res = await axios.post(`${this.baseUrl}/transaction`, {
                username: this.username,
                buyer_sku_code: productCode,
                customer_no: target,
                ref_id: trxId,
                sign: sign
            });

            const data = (res.data as any).data;

            return {
                status: mapDigiflazzStatus(data.status),
                vendorTrxId: data.ref_id, // Digiflazz uses same ref_id usually, or we can use their internal ID if provided
                message: data.message,
                sn: data.sn
            };
        } catch (error: any) {
            console.error('Digiflazz topUp error:', error.response?.data || error.message);
            return { status: 'failed', message: 'Connection Error' };
        }
    }

    async checkStatus(
        trxId: string,
        vendorTrxId?: string,
        productCode?: string,
        target?: string
    ): Promise<{ status: DigiflazzStatus; sn?: string; message?: string; }> {
        try {
            const refId = vendorTrxId || trxId;
            if (!productCode || !target) {
                return {
                    status: 'pending',
                    message: 'Digiflazz status check requires product code and target number'
                };
            }

            const res = await axios.post(`${this.baseUrl}/transaction`, {
                username: this.username,
                buyer_sku_code: productCode,
                customer_no: target,
                ref_id: refId,
                sign: this.sign(refId)
            });

            const data = (res.data as any)?.data || {};
            return {
                status: mapDigiflazzStatus(data.status),
                sn: data.sn,
                message: buildDigiflazzMessage(data)
            };
        } catch (error: any) {
            console.error('Digiflazz checkStatus error:', error?.response?.data || error?.message);
            return { status: 'pending', message: 'Status check failed' };
        }
    }
}
