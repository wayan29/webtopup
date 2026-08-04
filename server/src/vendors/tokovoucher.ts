import axios from 'axios';
import crypto from 'crypto';
import { IVendorAdapter } from './types';

type TVoucherStatus = 'pending' | 'success' | 'failed';

interface TokovoucherResponse {
    status: number;
    rc?: number;
    data?: any;
    message?: string;
    error_msg?: string;
}

const mapStatus = (raw?: string): TVoucherStatus => {
    const normalized = (raw || '').toLowerCase();
    if (normalized.includes('sukses') || normalized.includes('success')) return 'success';
    if (normalized.includes('gagal') || normalized.includes('failed')) return 'failed';
    return 'pending';
};

export class TokovoucherAdapter implements IVendorAdapter {
    private memberCode: string;
    private secret: string;
    private baseUrl: string;

    constructor(memberCode: string, secret: string, baseUrl: string = 'https://api.tokovoucher.net') {
        this.memberCode = memberCode;
        this.secret = secret;
        this.baseUrl = baseUrl;
    }

    private generateSignature(refId?: string): string {
        if (refId) {
            return crypto.createHash('md5').update(`${this.memberCode}:${this.secret}:${refId}`).digest('hex');
        }
        return crypto.createHash('md5').update(`${this.memberCode}:${this.secret}`).digest('hex');
    }

    async getBalance(): Promise<number> {
        try {
            const signature = this.generateSignature();
            const res = await axios.get<TokovoucherResponse>(`${this.baseUrl}/member`, {
                params: {
                    member_code: this.memberCode,
                    signature
                }
            });
            if (res.data?.data?.saldo !== undefined) {
                return res.data.data.saldo;
            }
            if (res.data?.error_msg) {
                throw new Error(res.data.error_msg);
            }
            return 0;
        } catch (error: any) {
            console.error('Tokovoucher getBalance error:', error?.response?.data || error?.message);
            throw error;
        }
    }

    // Get list of categories
    async getCategories(): Promise<any[]> {
        try {
            const signature = this.generateSignature();
            const res = await axios.get<TokovoucherResponse>(`${this.baseUrl}/member/produk/category/list`, {
                params: {
                    member_code: this.memberCode,
                    signature
                }
            });
            if (res.data?.status === 1 && res.data?.data) {
                return res.data.data;
            }
            return [];
        } catch (error: any) {
            console.error('Tokovoucher getCategories error:', error?.response?.data || error?.message);
            return [];
        }
    }

    // Get list of operators by category ID
    async getOperators(categoryId: number): Promise<any[]> {
        try {
            const signature = this.generateSignature();
            const res = await axios.get<TokovoucherResponse>(`${this.baseUrl}/member/produk/operator/list`, {
                params: {
                    member_code: this.memberCode,
                    signature,
                    id: categoryId
                }
            });
            if (res.data?.status === 1 && res.data?.data) {
                return res.data.data;
            }
            return [];
        } catch (error: any) {
            console.error('Tokovoucher getOperators error:', error?.response?.data || error?.message);
            return [];
        }
    }

    // Get list of jenis (types) by operator ID
    async getJenis(operatorId: number): Promise<any[]> {
        try {
            const signature = this.generateSignature();
            const res = await axios.get<TokovoucherResponse>(`${this.baseUrl}/member/produk/jenis/list`, {
                params: {
                    member_code: this.memberCode,
                    signature,
                    id: operatorId
                }
            });
            if (res.data?.status === 1 && res.data?.data) {
                return res.data.data;
            }
            return [];
        } catch (error: any) {
            console.error('Tokovoucher getJenis error:', error?.response?.data || error?.message);
            return [];
        }
    }

    // Get list of products by jenis ID
    async getProducts(jenisId: number): Promise<any[]> {
        try {
            const signature = this.generateSignature();
            const res = await axios.get<TokovoucherResponse>(`${this.baseUrl}/member/produk/list`, {
                params: {
                    member_code: this.memberCode,
                    signature,
                    id_jenis: jenisId
                }
            });
            if (res.data?.status === 1 && res.data?.data) {
                return res.data.data;
            }
            return [];
        } catch (error: any) {
            console.error('Tokovoucher getProducts error:', error?.response?.data || error?.message);
            return [];
        }
    }

    // Search products by SKU code or prefix
    async searchByCode(kode: string): Promise<any[]> {
        try {
            const signature = this.generateSignature();
            const res = await axios.get<TokovoucherResponse>(`${this.baseUrl}/produk/code`, {
                params: {
                    member_code: this.memberCode,
                    signature,
                    kode
                }
            });
            if (res.data?.status === 1 && res.data?.data) {
                return res.data.data;
            }
            if (res.data?.error_msg) {
                return [];
            }
            return [];
        } catch (error: any) {
            console.error('Tokovoucher searchByCode error:', error?.response?.data || error?.message);
            return [];
        }
    }

    // Legacy method - get all products (slow, for backwards compatibility)
    async getPriceList(): Promise<any[]> {
        // Return empty - use cascading filters instead
        return [];
    }

    async topUp(trxId: string, productCode: string, target: string, serverId?: string): Promise<{
        status: TVoucherStatus;
        vendorTrxId?: string;
        message?: string;
        sn?: string;
    }> {
        try {
            const signature = this.generateSignature(trxId);
            const res = await axios.post<TokovoucherResponse>(`${this.baseUrl}/v1/transaksi`, {
                ref_id: trxId,
                produk: productCode,
                tujuan: target,
                server_id: serverId || '',
                member_code: this.memberCode,
                signature
            });

            const data = res.data?.data || res.data || {};
            return {
                status: mapStatus(data.status),
                vendorTrxId: data.ref_id || data.trxid,
                message: data.message || res.data?.message,
                sn: data.sn
            };
        } catch (error: any) {
            console.error('Tokovoucher topUp error:', error?.response?.data || error?.message);
            return { status: 'failed', message: 'Connection Error' };
        }
    }

    async checkStatus(trxId: string, vendorTrxId?: string): Promise<{
        status: TVoucherStatus;
        sn?: string;
        message?: string;
    }> {
        try {
            const refId = vendorTrxId || trxId;
            const signature = this.generateSignature(refId);
            const res = await axios.post<TokovoucherResponse>(`${this.baseUrl}/v1/transaksi/status`, {
                ref_id: refId,
                member_code: this.memberCode,
                signature
            });

            const data = res.data?.data || res.data || {};
            return {
                status: mapStatus(data.status),
                sn: data.sn,
                message: data.message
            };
        } catch (error: any) {
            console.error('Tokovoucher checkStatus error:', error?.response?.data || error?.message);
            return { status: 'pending', message: 'Status check failed' };
        }
    }
}
