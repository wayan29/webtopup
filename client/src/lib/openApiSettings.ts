export type SettingsTabId = 'preferences' | 'api' | 'security';

export const SETTINGS_TABS: SettingsTabId[] = ['preferences', 'api', 'security'];

export function parseSettingsTab(value: unknown): SettingsTabId {
    return value === 'api' || value === 'security' || value === 'preferences' ? value : 'preferences';
}

export type OpenApiSecretStatus = 'visible' | 'stored-hidden' | 'missing';

export function openApiSecretStatus(input: {
    plaintext: string | null;
    hasStoredSecret: boolean;
}): OpenApiSecretStatus {
    if (input.plaintext) return 'visible';
    if (input.hasStoredSecret) return 'stored-hidden';
    return 'missing';
}

export function canCopyOpenApiSecret(status: OpenApiSecretStatus): boolean {
    return status === 'visible';
}

export function maskOpenApiKey(apiKey: string | null | undefined): string {
    if (!apiKey) return '';
    if (apiKey.length <= 16) {
        const visible = Math.min(2, Math.floor(apiKey.length / 2));
        return `${apiKey.slice(0, visible)}${'*'.repeat(Math.max(0, apiKey.length - visible * 2))}${apiKey.slice(apiKey.length - visible)}`;
    }
    return `${apiKey.slice(0, 8)}${'*'.repeat(apiKey.length - 16)}${apiKey.slice(-8)}`;
}

export function buildOpenApiBaseUrl(rawApiV2Base: string, origin: string): string {
    const trimmed = rawApiV2Base.replace(/\/$/, '') || '/api/v2';
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        return `${trimmed}/api`;
    }
    const path = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    return `${origin.replace(/\/$/, '')}${path}/api`;
}

export const OPEN_API_LIST_SIGNATURE = 'md5(member_id:api_key:secret)';
export const OPEN_API_ORDER_SIGNATURE = 'md5(member_id:api_key:secret:ref_id)';

export type OpenApiEndpoint = {
    method: 'GET' | 'POST';
    path: string;
    description: string;
    extra?: string;
};

export const OPEN_API_ENDPOINTS: OpenApiEndpoint[] = [
    { method: 'GET', path: '/profile', description: 'Cek profil, level harga, dan saldo aktif Anda saat ini.' },
    { method: 'GET', path: '/categories', description: 'Daftar semua kategori produk aktif di platform.' },
    { method: 'GET', path: '/operators?category=category_id', description: 'Daftar brand/operator aktif, bisa difilter berdasarkan ID Kategori.' },
    { method: 'GET', path: '/product-types?category=category_id&operator=operator_id', description: 'Daftar tipe produk aktif berdasarkan Kategori dan Brand.' },
    { method: 'GET', path: '/products?category=category_id&operator=operator_id&type=type_id', description: 'Daftar katalog produk lengkap beserta harga khusus sesuai level member Anda.' },
    { method: 'POST', path: '/order', description: 'Membuat transaksi pembelian baru (parameter Tokovoucher).', extra: 'Body: { member_id, api_key, signature, ref_id, produk, tujuan, server_id? }' },
    { method: 'POST', path: '/transaction', description: 'Membuat transaksi pembelian baru (alias endpoint lama).', extra: 'Body: { member_id, api_key, signature, ref_id, product_code, target, server_id? }' },
    { method: 'GET', path: '/transaction/check?ref_id=xxx&member_id=xxx&api_key=xxx&signature=xxx', description: 'Cek detail dan status pengiriman transaksi secara real-time.' },
    { method: 'GET', path: '/transactions', description: 'Riwayat ringkasan transaksi API akun Anda.' },
];

export function openApiCurlExamples(baseUrl: string): string {
    const root = baseUrl.replace(/\/$/, '');
    return [
        '# 1. Mengambil katalog produk',
        '# signature = md5(MEMBER_ID:API_KEY:SECRET)',
        `curl -X GET "${root}/products?member_id=MEMBER_ID&api_key=API_KEY&signature=SIGNATURE"`,
        '',
        '# 2. Membuat transaksi baru',
        '# signature = md5(MEMBER_ID:API_KEY:SECRET:REF_ID)',
        `curl -X POST "${root}/order" \\`,
        '  -H "Content-Type: application/json" \\',
        "  -d '{\"member_id\":\"MEMBER_ID\",\"api_key\":\"API_KEY\",\"signature\":\"SIGNATURE\",\"ref_id\":\"REF_ID\",\"produk\":\"ML86\",\"tujuan\":\"123456789\",\"server_id\":\"1234\"}'",
    ].join('\n');
}
