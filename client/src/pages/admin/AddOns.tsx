import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Settings, CreditCard, BarChart3, MessageSquare, Server, Zap, RefreshCw } from 'lucide-react';
import { apiV2 } from '../../api';

type AddOnCategory = 'Semua' | 'Mutasi' | 'Payment' | 'Vendor' | 'Wa';
type AddOnStatus = 'ready' | 'needs_setup' | 'attention' | 'coming_soon';

type AddOn = {
    id: string;
    name: string;
    description: string;
    category: AddOnCategory;
    icon: 'payment' | 'chart' | 'message' | 'server' | 'zap';
    status: AddOnStatus;
    note: string;
    settingPath?: string;
    available: boolean;
};

type VendorSettingsResponse = {
    configured?: boolean;
};

type DigiflazzSellerSettingsResponse = {
    configured?: boolean;
    ready?: boolean;
    publicBaseUrl?: string;
    mappingSummary?: {
        active?: number;
    };
};

type WebhookConfigResponse = {
    protectionMode?: 'signature' | 'ip_only' | 'unprotected';
    protected?: boolean;
};

const iconMap = {
    payment: CreditCard,
    chart: BarChart3,
    message: MessageSquare,
    server: Server,
    zap: Zap,
};

const colorMap = {
    payment: 'ui-info-chip',
    chart: 'ui-success-chip',
    message: 'ui-accent-chip',
    server: 'ui-warning-chip',
    zap: 'ui-warning-chip',
};

const baseAddOns: Omit<AddOn, 'status' | 'note'>[] = [
    { id: 'tokoconvert', name: 'TOKOCONVERT', description: 'Integrasi payment belum tersedia di admin ini.', category: 'Payment', icon: 'payment', available: false },
    { id: 'durianpay', name: 'DURIANPAY', description: 'Integrasi payment belum tersedia di admin ini.', category: 'Payment', icon: 'payment', available: false },
    { id: 'cek-mutasi', name: 'CEK MUTASI', description: 'Integrasi mutasi belum tersedia di admin ini.', category: 'Mutasi', icon: 'chart', available: false },
    { id: 'terachat', name: 'TERACHAT', description: 'Integrasi WhatsApp belum tersedia di admin ini.', category: 'Wa', icon: 'message', available: false },
    { id: 'easywa', name: 'EASYWA', description: 'Integrasi WhatsApp belum tersedia di admin ini.', category: 'Wa', icon: 'message', available: false },
    { id: 'mesin-otomatis', name: 'MESIN OTOMATIS', description: 'Belum ada pengaturan khusus di panel ini.', category: 'Vendor', icon: 'zap', available: false },
    { id: 'digiflazz', name: 'DIGIFLAZZ', description: 'Vendor H2H Pulsa, Data, PLN, dll', category: 'Vendor', icon: 'server', available: true, settingPath: '/admin/addons/digiflazz' },
    { id: 'digiflazz-seller', name: 'DIGIFLAZZ SELLER', description: 'Expose produk lokal Anda ke Digiflazz Seller API', category: 'Vendor', icon: 'server', available: true, settingPath: '/admin/addons/digiflazz-seller' },
    { id: 'tokovoucher', name: 'TOKOVOUCHER', description: 'Vendor H2H Voucher Game, Pulsa, Data', category: 'Vendor', icon: 'server', available: true, settingPath: '/admin/addons/tokovoucher' },
];

const categories: AddOnCategory[] = ['Semua', 'Mutasi', 'Payment', 'Vendor', 'Wa'];

const statusStyles: Record<AddOnStatus, string> = {
    ready: 'ui-success-chip',
    needs_setup: 'ui-warning-chip',
    attention: 'ui-danger-chip',
    coming_soon: 'ui-panel ui-text-muted',
};

const statusLabel: Record<AddOnStatus, string> = {
    ready: 'Siap',
    needs_setup: 'Perlu Setup',
    attention: 'Perlu Tindakan',
    coming_soon: 'Belum Tersedia',
};

export default function AddOns() {
    const navigate = useNavigate();
    const [category, setCategory] = useState<AddOnCategory>('Semua');
    const [search, setSearch] = useState('');
    const [loading, setLoading] = useState(true);
    const [message, setMessage] = useState<{ type: 'error' | 'success'; text: string } | null>(null);
    const [addons, setAddons] = useState<AddOn[]>(() =>
        baseAddOns.map((addon) => ({
            ...addon,
            status: addon.available ? 'needs_setup' : 'coming_soon',
            note: addon.available ? 'Memuat status integrasi...' : 'Addon ini belum tersedia di panel admin.'
        }))
    );

    const fetchStatuses = async () => {
        try {
            setLoading(true);
            setMessage(null);

            const [digiflazzSettings, digiflazzSellerSettings, tokovoucherSettings, digiflazzWebhook, tokovoucherWebhook] = await Promise.allSettled([
                apiV2.get<VendorSettingsResponse>('/vendors/digiflazz/settings'),
                apiV2.get<DigiflazzSellerSettingsResponse>('/digiflazz-seller/settings'),
                apiV2.get<VendorSettingsResponse>('/vendors/tokovoucher/settings'),
                apiV2.get<WebhookConfigResponse>('/webhook/digiflazz/config'),
                apiV2.get<WebhookConfigResponse>('/webhook/tokovoucher/config')
            ]);

            const digiflazzConfigured = digiflazzSettings.status === 'fulfilled' && Boolean(digiflazzSettings.value.data?.configured);
            const digiflazzSellerConfigured = digiflazzSellerSettings.status === 'fulfilled' && Boolean(digiflazzSellerSettings.value.data?.configured);
            const digiflazzSellerReady = digiflazzSellerSettings.status === 'fulfilled' && Boolean(digiflazzSellerSettings.value.data?.ready);
            const digiflazzSellerPublicBaseUrl = digiflazzSellerSettings.status === 'fulfilled' && Boolean(digiflazzSellerSettings.value.data?.publicBaseUrl);
            const digiflazzSellerActiveMappings = digiflazzSellerSettings.status === 'fulfilled'
                ? Number(digiflazzSellerSettings.value.data?.mappingSummary?.active || 0)
                : 0;
            const digiflazzProtection = digiflazzWebhook.status === 'fulfilled'
                ? digiflazzWebhook.value.data?.protectionMode || 'unprotected'
                : 'unprotected';
            const tokovoucherConfigured = tokovoucherSettings.status === 'fulfilled' && Boolean(tokovoucherSettings.value.data?.configured);
            const tokovoucherProtection = tokovoucherWebhook.status === 'fulfilled'
                ? tokovoucherWebhook.value.data?.protectionMode || 'unprotected'
                : 'unprotected';

            setAddons(baseAddOns.map((addon) => {
                if (addon.id === 'digiflazz') {
                    if (!digiflazzConfigured) {
                        return {
                            ...addon,
                            status: 'needs_setup',
                            note: 'Kredensial Digiflazz belum lengkap.'
                        };
                    }

                    if (digiflazzProtection === 'unprotected') {
                        return {
                            ...addon,
                            status: 'attention',
                            note: 'Webhook masih belum terlindungi. Atur secret atau whitelist IP.'
                        };
                    }

                    return {
                        ...addon,
                        status: 'ready',
                        note: digiflazzProtection === 'ip_only'
                            ? 'Kredensial aktif, webhook dilindungi via whitelist IP.'
                            : 'Kredensial aktif, webhook signature sudah terlindungi.'
                    };
                }

                if (addon.id === 'digiflazz-seller') {
                    if (!digiflazzSellerConfigured) {
                        return {
                            ...addon,
                            status: 'needs_setup',
                            note: 'Kredensial Digiflazz Seller belum lengkap.'
                        };
                    }

                    if (!digiflazzSellerPublicBaseUrl) {
                        return {
                            ...addon,
                            status: 'attention',
                            note: 'Public Base URL belum diisi, endpoint seller belum siap didaftarkan.'
                        };
                    }

                    if (digiflazzSellerActiveMappings === 0) {
                        return {
                            ...addon,
                            status: 'attention',
                            note: 'Belum ada mapping produk aktif untuk dijual ke Digiflazz.'
                        };
                    }

                    return {
                        ...addon,
                        status: digiflazzSellerReady ? 'ready' : 'attention',
                        note: digiflazzSellerReady
                            ? `Seller API siap dengan ${digiflazzSellerActiveMappings} mapping aktif.`
                            : 'Konfigurasi seller hampir siap, cek endpoint dan mapping aktif.'
                    };
                }

                if (addon.id === 'tokovoucher') {
                    if (!tokovoucherConfigured) {
                        return {
                            ...addon,
                            status: 'needs_setup',
                            note: 'Kredensial Tokovoucher belum lengkap.'
                        };
                    }

                    if (tokovoucherProtection === 'unprotected') {
                        return {
                            ...addon,
                            status: 'attention',
                            note: 'Webhook belum punya perlindungan tambahan. Periksa whitelist IP.'
                        };
                    }

                    return {
                        ...addon,
                        status: 'ready',
                        note: tokovoucherProtection === 'ip_only'
                            ? 'Kredensial aktif, webhook dibatasi whitelist IP.'
                            : 'Kredensial aktif dan signature webhook siap.'
                    };
                }

                return {
                    ...addon,
                    status: 'coming_soon',
                    note: 'Addon ini belum tersedia di panel admin.'
                };
            }));

            const failedCount = [digiflazzSettings, digiflazzSellerSettings, tokovoucherSettings, digiflazzWebhook, tokovoucherWebhook]
                .filter((item) => item.status === 'rejected').length;

            if (failedCount > 0) {
                setMessage({
                    type: 'error',
                    text: 'Sebagian status addon tidak bisa dimuat. Anda masih bisa membuka integrasi yang tersedia.'
                });
            }
        } catch {
            setMessage({ type: 'error', text: 'Gagal memuat status addon' });
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchStatuses();
    }, []);

    const filtered = useMemo(() => {
        const keyword = search.trim().toLowerCase();
        return addons.filter((addon) => {
            const matchCategory = category === 'Semua' || addon.category === category;
            const matchSearch = !keyword
                || addon.name.toLowerCase().includes(keyword)
                || addon.description.toLowerCase().includes(keyword)
                || addon.note.toLowerCase().includes(keyword);
            return matchCategory && matchSearch;
        });
    }, [addons, category, search]);

    const summary = useMemo(() => ({
        total: addons.length,
        ready: addons.filter((addon) => addon.status === 'ready').length,
        attention: addons.filter((addon) => addon.status === 'attention' || addon.status === 'needs_setup').length,
        comingSoon: addons.filter((addon) => addon.status === 'coming_soon').length
    }), [addons]);

    const handleSetting = (addon: AddOn) => {
        if (!addon.settingPath) return;
        navigate(addon.settingPath);
    };

    return (
        <div className="space-y-5">
            <div className="ui-panel-muted border ui-border rounded-xl p-4 flex flex-wrap gap-2">
                <button
                    onClick={fetchStatuses}
                    className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border text-sm font-semibold ui-muted-action hover:border-[var(--ui-accent)]"
                >
                    <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                    Reload Status
                </button>
            </div>

            {message && (
                <div className={`rounded-xl border px-4 py-3 text-sm ${message.type === 'error' ? 'ui-danger-chip' : 'ui-success-chip'}`}>
                    {message.text}
                </div>
            )}

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <div className="ui-panel-muted border ui-border rounded-xl p-5">
                    <div className="text-xs uppercase tracking-[0.18em] ui-text-muted">Total Addon</div>
                    <div className="mt-2 text-3xl font-black ui-text">{summary.total}</div>
                    <p className="mt-1 text-sm ui-text-muted">Integrasi yang terdaftar di pusat addon.</p>
                </div>
                <div className="ui-panel-muted border ui-border rounded-xl p-5">
                    <div className="text-xs uppercase tracking-[0.18em] ui-success-text">Siap Dipakai</div>
                    <div className="mt-2 text-3xl font-black ui-success-text">{summary.ready}</div>
                    <p className="mt-1 text-sm ui-text-muted">Integrasi aktif dengan proteksi yang cukup.</p>
                </div>
                <div className="ui-panel-muted border ui-border rounded-xl p-5">
                    <div className="text-xs uppercase tracking-[0.18em] ui-warning-text">Perlu Tindakan</div>
                    <div className="mt-2 text-3xl font-black ui-warning-text">{summary.attention}</div>
                    <p className="mt-1 text-sm ui-text-muted">Butuh setup kredensial atau penguatan webhook.</p>
                </div>
                <div className="ui-panel-muted border ui-border rounded-xl p-5">
                    <div className="text-xs uppercase tracking-[0.18em] ui-text-muted">Belum Tersedia</div>
                    <div className="mt-2 text-3xl font-black ui-text">{summary.comingSoon}</div>
                    <p className="mt-1 text-sm ui-text-muted">Masih placeholder, belum ada pengaturan admin nyata.</p>
                </div>
            </div>

            <div className="flex flex-wrap gap-2">
                {categories.map((cat) => (
                    <button
                        key={cat}
                        onClick={() => setCategory(cat)}
                        className={`px-4 py-2 rounded-full text-sm font-semibold border ${
                            category === cat
                                ? 'ui-accent-solid border-[var(--ui-accent)]'
                                : 'ui-panel ui-text-muted ui-border hover:bg-[var(--ui-card-muted)]'
                        }`}
                    >
                        {cat}
                    </button>
                ))}
            </div>

            <div className="ui-panel-muted border ui-border rounded-xl p-4">
                <div className="relative w-full md:w-96">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                        <Search className="h-5 w-5 ui-text-muted" />
                    </div>
                    <input
                        className="block w-full pl-10 pr-3 py-2 border rounded-md leading-5 ui-field sm:text-sm"
                        placeholder="Cari addon, deskripsi, atau status..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                    />
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {filtered.map((addon) => {
                    const IconComponent = iconMap[addon.icon];
                    return (
                        <div key={addon.id} className="ui-panel-muted border ui-border rounded-xl p-4 flex gap-3 items-start">
                            <div className={`h-12 w-12 rounded-full flex items-center justify-center ${colorMap[addon.icon]}`}>
                                <IconComponent className="w-6 h-6" />
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                    <div className="text-lg font-semibold ui-text">{addon.name}</div>
                                    <span className={`px-2 py-1 rounded-full text-xs font-semibold ${statusStyles[addon.status]}`}>
                                        {statusLabel[addon.status]}
                                    </span>
                                </div>
                                <div className="mt-1 text-sm ui-text-muted">{addon.description}</div>
                                <div className="mt-2 text-sm ui-text">{addon.note}</div>
                            </div>
                            <div className="flex flex-col items-end gap-2 shrink-0">
                                {addon.settingPath ? (
                                    <button
                                        onClick={() => handleSetting(addon)}
                                        className="inline-flex items-center gap-1 ui-info-text text-sm font-semibold hover:opacity-80"
                                    >
                                        <Settings className="w-4 h-4" />
                                        Setting
                                    </button>
                                ) : (
                                    <span className="text-xs ui-text-muted">Tidak ada setting</span>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
