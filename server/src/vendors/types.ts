export interface IVendorAdapter {
    getBalance(): Promise<number>;
    getPriceList(): Promise<any[]>;
    topUp(trxId: string, productCode: string, target: string, serverId?: string): Promise<{
        status: 'pending' | 'success' | 'failed';
        vendorTrxId?: string;
        message?: string;
        sn?: string;
    }>;
    checkStatus(trxId: string, vendorTrxId?: string, productCode?: string, target?: string): Promise<{
        status: 'pending' | 'success' | 'failed';
        sn?: string;
        message?: string;
    }>;
}
