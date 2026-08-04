import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Info, Save, Loader2, RefreshCcw } from 'lucide-react';
import { apiV2 } from '../../api';
import ImagePickerField from '../../components/admin/ImagePickerField';

type TabKey = 'web' | 'contact' | 'system' | 'other' | 'banner' | 'refid';

interface SettingsForm {
    // Web Config
    brand: string;
    title: string;
    favicon: string;
    logo: string;
    description: string;
    
    // Contact
    whatsapp: string;
    telegram: string;
    email: string;
    instagram: string;
    facebook: string;
    twitter: string;
    youtube: string;
    address: string;
    
    // System
    maintenanceMode: boolean;
    maintenanceMessage: string;
    registrationEnabled: boolean;
    guestCheckoutEnabled: boolean;
    minDeposit: number;
    maxDeposit: number;
    depositFee: number;
    depositFeeType: 'fixed' | 'percent';
    
    // Other
    footerText: string;
    termsUrl: string;
    privacyUrl: string;
    googleAnalyticsId: string;
    facebookPixelId: string;
    
    // Popup Banner
    popupBannerEnabled: boolean;
    popupBannerImage: string;
    popupBannerLink: string;
    popupBannerTitle: string;
    popupBannerDescription: string;
    
    // Ref ID & Invoice
    refIdPrefix: string;
    refIdDateFormat: string;
    refIdSeparator: string;
    refIdSequenceDigits: number;
    refIdSample: string;
    invoicePrefix: string;
    invoiceDateFormat: string;
    invoiceSeparator: string;
    invoiceRandomLength: number;
    invoiceRandomType: string;
    invoiceSample: string;
}

const defaultForm: SettingsForm = {
    brand: 'Danayasa',
    title: 'Danayasa - Top Up Game Termurah',
    favicon: '/danayasa-favicon.svg',
    logo: '/danayasa-logo.svg',
    description: 'Topup Game Terlengkap & Termurah',
    whatsapp: '',
    telegram: '',
    email: '',
    instagram: '',
    facebook: '',
    twitter: '',
    youtube: '',
    address: '',
    maintenanceMode: false,
    maintenanceMessage: 'Sistem sedang dalam pemeliharaan. Silakan coba beberapa saat lagi.',
    registrationEnabled: true,
    guestCheckoutEnabled: true,
    minDeposit: 10000,
    maxDeposit: 10000000,
    depositFee: 0,
    depositFeeType: 'fixed',
    footerText: '© 2026 Danayasa. All Rights Reserved.',
    termsUrl: '',
    privacyUrl: '',
    googleAnalyticsId: '',
    facebookPixelId: '',
    popupBannerEnabled: false,
    popupBannerImage: '',
    popupBannerLink: '',
    popupBannerTitle: '',
    popupBannerDescription: '',
    refIdPrefix: 'REF',
    refIdDateFormat: 'DDMMYYYY',
    refIdSeparator: '',
    refIdSequenceDigits: 4,
    refIdSample: '',
    invoicePrefix: 'INV',
    invoiceDateFormat: 'YYYYMMDD',
    invoiceSeparator: '',
    invoiceRandomLength: 6,
    invoiceRandomType: 'alphanumeric',
    invoiceSample: '',
};

export default function SiteConfig() {
    const [activeTab, setActiveTab] = useState<TabKey>('web');
    const [form, setForm] = useState<SettingsForm>(defaultForm);
    const [lastSavedForm, setLastSavedForm] = useState<SettingsForm>(defaultForm);
    const latestRequestId = useRef(0);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
    const [pendingConfirmMessage, setPendingConfirmMessage] = useState<string | null>(null);

    useEffect(() => {
        fetchSettings();
    }, []);

    useEffect(() => {
        const handler = () => fetchSettings();
        window.addEventListener('admin:refresh-current-page', handler);
        return () => window.removeEventListener('admin:refresh-current-page', handler);
    }, []);

    const fetchSettings = async () => {
        const requestId = latestRequestId.current + 1;
        latestRequestId.current = requestId;
        try {
            setLoading(true);
            setMessage(null);
            const res = await apiV2.get('/settings/admin/all');
            if (requestId !== latestRequestId.current) return;
            const nextForm = { ...defaultForm, ...res.data };
            setForm(nextForm);
            setLastSavedForm(nextForm);
        } catch (error: any) {
            if (requestId !== latestRequestId.current) return;
            console.error('Failed to load settings', error);
            setMessage({
                type: 'error',
                text: error.response?.data?.message || 'Gagal memuat pengaturan situs.'
            });
        } finally {
            if (requestId === latestRequestId.current) {
                setLoading(false);
            }
        }
    };

    const isSafeUrlOrPath = (value: string) => {
        const normalized = value.trim();

        if (!normalized) {
            return true;
        }

        if (normalized.startsWith('/')) {
            return !normalized.startsWith('//');
        }

        try {
            const parsed = new URL(normalized);
            return parsed.protocol === 'https:';
        } catch {
            return false;
        }
    };

    const validateForm = () => {
        if (!form.brand.trim()) {
            return 'Brand wajib diisi.';
        }

        if (!form.title.trim()) {
            return 'Judul website wajib diisi.';
        }

        if (form.maxDeposit < form.minDeposit) {
            return 'Maximum deposit tidak boleh lebih kecil dari minimum deposit.';
        }

        if (form.depositFee < 0) {
            return 'Biaya deposit tidak boleh negatif.';
        }

        if (form.depositFeeType === 'percent' && form.depositFee > 100) {
            return 'Biaya deposit persentase harus di antara 0% sampai 100%.';
        }

        if (form.maintenanceMode && !form.maintenanceMessage.trim()) {
            return 'Pesan maintenance wajib diisi saat maintenance aktif.';
        }

        if (form.popupBannerEnabled && !form.popupBannerImage.trim()) {
            return 'Gambar popup banner wajib diisi saat popup aktif.';
        }

        if (!isSafeUrlOrPath(form.favicon) || !isSafeUrlOrPath(form.logo)) {
            return 'Favicon dan logo harus berupa URL https atau path internal.';
        }

        if (!isSafeUrlOrPath(form.popupBannerImage) || !isSafeUrlOrPath(form.popupBannerLink)) {
            return 'URL popup banner tidak valid.';
        }

        if (!isSafeUrlOrPath(form.termsUrl) || !isSafeUrlOrPath(form.privacyUrl)) {
            return 'URL terms atau privacy tidak valid.';
        }

        return null;
    };

    const getChangedPayload = () => {
        const payload: Partial<SettingsForm> = {};
        (Object.keys(form) as Array<keyof SettingsForm>).forEach((key) => {
            if (key === 'refIdSample' || key === 'invoiceSample') return;
            if (form[key] !== lastSavedForm[key]) {
                (payload as any)[key] = form[key];
            }
        });
        return payload;
    };

    const getSensitiveChangeMessage = () => {
        const warnings: string[] = [];
        if (!lastSavedForm.maintenanceMode && form.maintenanceMode) warnings.push('Mode maintenance akan diaktifkan dan dapat membatasi akses layanan.');
        if (lastSavedForm.registrationEnabled && !form.registrationEnabled) warnings.push('Registrasi member baru akan dinonaktifkan.');
        if (lastSavedForm.guestCheckoutEnabled && !form.guestCheckoutEnabled) warnings.push('Guest checkout akan dinonaktifkan.');
        if (
            form.minDeposit !== lastSavedForm.minDeposit
            || form.maxDeposit !== lastSavedForm.maxDeposit
            || form.depositFee !== lastSavedForm.depositFee
            || form.depositFeeType !== lastSavedForm.depositFeeType
        ) {
            warnings.push('Konfigurasi deposit akan berubah dan berdampak ke pembayaran member.');
        }
        return warnings.length ? warnings.join(' ') : null;
    };

    const handleSave = async (skipConfirm = false) => {
        try {
            const validationError = validateForm();
            if (validationError) {
                setMessage({ type: 'error', text: validationError });
                return;
            }

            const sensitiveChangeMessage = getSensitiveChangeMessage();
            if (!skipConfirm && sensitiveChangeMessage) {
                setPendingConfirmMessage(sensitiveChangeMessage);
                return;
            }

            const payload = getChangedPayload();
            if (Object.keys(payload).length === 0) {
                setMessage({ type: 'success', text: 'Tidak ada perubahan pengaturan.' });
                return;
            }

            setSaving(true);
            setMessage(null);
            setPendingConfirmMessage(null);
            const res = await apiV2.put('/settings/admin/update', payload);
            const nextForm = { ...defaultForm, ...(res.data?.data || form) };
            setForm(nextForm);
            setLastSavedForm(nextForm);
            setMessage({ type: 'success', text: 'Pengaturan situs berhasil disimpan.' });
        } catch (error: any) {
            console.error('Failed to save settings', error);
            setMessage({
                type: 'error',
                text: error.response?.data?.message || 'Gagal menyimpan pengaturan.'
            });
        } finally {
            setSaving(false);
        }
    };

    const invoicePreviewSeed = useMemo(() => Math.random().toString(36).slice(2, 14).toUpperCase(), [form.invoiceRandomLength, form.invoiceRandomType]);

    const parseIntegerInput = (value: string) => {
        if (value.trim() === '') return 0;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
    };

    const tabs: { key: TabKey; label: string }[] = [
        { key: 'web', label: 'Web Config' },
        { key: 'contact', label: 'Kontak' },
        { key: 'system', label: 'Pengaturan Sistem' },
        { key: 'other', label: 'Pengaturan Lainnya' },
        { key: 'banner', label: 'Popup Banner' },
        { key: 'refid', label: 'Ref ID & Invoice' },
    ];

    const inputClass = "w-full border rounded-lg px-3 py-2 ui-field";
    const labelClass = "block text-sm font-medium ui-text mb-1";
    const checkboxClass = "w-4 h-4 rounded border-[var(--ui-border)] bg-[var(--ui-card-bg)] text-[var(--ui-accent)] focus:ring-[var(--ui-accent)]";

    const renderWebTab = () => (
        <div className="space-y-4">
            <div className="rounded-lg border border-[color-mix(in_srgb,var(--ui-accent)_28%,transparent)] bg-[var(--ui-accent-soft)] p-4 text-sm ui-text">
                <div className="flex items-start gap-3">
                    <Info className="mt-0.5 h-4 w-4 shrink-0 ui-accent-text" />
                    <div>
                        <p className="font-semibold ui-accent-text">UI Theme tidak diatur di sini</p>
                        <p className="mt-1 ui-text-muted">
                            Theme antarmuka sekarang bersifat personal per user login. Staff atau admin yang mengganti tema hanya mengubah tampilan akunnya sendiri, dan member login juga mengatur tema dari halaman pengaturan akun.
                        </p>
                    </div>
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                    <label className={labelClass}>Brand</label>
                    <input
                        className={inputClass}
                        value={form.brand}
                        onChange={(e) => setForm({ ...form, brand: e.target.value })}
                        placeholder="Nama brand"
                    />
                </div>
                <div>
                    <label className={labelClass}>Judul Website</label>
                    <input
                        className={inputClass}
                        value={form.title}
                        onChange={(e) => setForm({ ...form, title: e.target.value })}
                        placeholder="Judul halaman"
                    />
                </div>
            </div>
            <div>
                <label className={labelClass}>Deskripsi Website</label>
                <textarea
                    className={inputClass}
                    value={form.description}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                    rows={3}
                    placeholder="Deskripsi singkat website"
                />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                    <label className={labelClass}>Favicon</label>
                    <ImagePickerField
                        value={form.favicon}
                        onChange={(url: string) => setForm({ ...form, favicon: url })}
                        folder="icons"
                    />
                </div>
                <div>
                    <label className={labelClass}>Logo</label>
                    <ImagePickerField
                        value={form.logo}
                        onChange={(url: string) => setForm({ ...form, logo: url })}
                        folder="icons"
                    />
                </div>
            </div>
        </div>
    );

    const renderContactTab = () => (
        <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                    <label className={labelClass}>WhatsApp</label>
                    <input
                        className={inputClass}
                        value={form.whatsapp}
                        onChange={(e) => setForm({ ...form, whatsapp: e.target.value })}
                        placeholder="6281234567890"
                    />
                    <p className="text-xs ui-text-muted mt-1">Format: 628xxx tanpa + atau spasi</p>
                </div>
                <div>
                    <label className={labelClass}>Telegram</label>
                    <input
                        className={inputClass}
                        value={form.telegram}
                        onChange={(e) => setForm({ ...form, telegram: e.target.value })}
                        placeholder="@username atau https://t.me/username"
                    />
                </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                    <label className={labelClass}>Email</label>
                    <input
                        type="email"
                        className={inputClass}
                        value={form.email}
                        onChange={(e) => setForm({ ...form, email: e.target.value })}
                        placeholder="support@example.com"
                    />
                </div>
                <div>
                    <label className={labelClass}>Instagram</label>
                    <input
                        className={inputClass}
                        value={form.instagram}
                        onChange={(e) => setForm({ ...form, instagram: e.target.value })}
                        placeholder="@username"
                    />
                </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                    <label className={labelClass}>Facebook</label>
                    <input
                        className={inputClass}
                        value={form.facebook}
                        onChange={(e) => setForm({ ...form, facebook: e.target.value })}
                        placeholder="https://facebook.com/page"
                    />
                </div>
                <div>
                    <label className={labelClass}>Twitter / X</label>
                    <input
                        className={inputClass}
                        value={form.twitter}
                        onChange={(e) => setForm({ ...form, twitter: e.target.value })}
                        placeholder="@username"
                    />
                </div>
            </div>
            <div>
                <label className={labelClass}>YouTube</label>
                <input
                    className={inputClass}
                    value={form.youtube}
                    onChange={(e) => setForm({ ...form, youtube: e.target.value })}
                    placeholder="https://youtube.com/@channel"
                />
            </div>
            <div>
                <label className={labelClass}>Alamat</label>
                <textarea
                    className={inputClass}
                    value={form.address}
                    onChange={(e) => setForm({ ...form, address: e.target.value })}
                    rows={2}
                    placeholder="Alamat kantor/toko"
                />
            </div>
        </div>
    );

    const renderSystemTab = () => (
        <div className="space-y-4">
            <div className="ui-panel-muted rounded-lg p-4 border ui-border">
                <h3 className="text-sm font-semibold ui-accent-text mb-3">Mode Maintenance</h3>
                <div className="flex items-center gap-3 mb-3">
                    <input
                        type="checkbox"
                        id="maintenanceMode"
                        checked={form.maintenanceMode}
                        onChange={(e) => setForm({ ...form, maintenanceMode: e.target.checked })}
                        className={checkboxClass}
                    />
                    <label htmlFor="maintenanceMode" className="text-sm ui-text">
                        Aktifkan Mode Maintenance
                    </label>
                </div>
                {form.maintenanceMode && (
                    <div>
                        <label className={labelClass}>Pesan Maintenance</label>
                        <textarea
                            className={inputClass}
                            value={form.maintenanceMessage}
                            onChange={(e) => setForm({ ...form, maintenanceMessage: e.target.value })}
                            rows={2}
                        />
                    </div>
                )}
            </div>

            <div className="ui-panel-muted rounded-lg p-4 border ui-border">
                <h3 className="text-sm font-semibold ui-accent-text mb-3">Fitur</h3>
                <div className="space-y-3">
                    <div className="flex items-center gap-3">
                        <input
                            type="checkbox"
                            id="registrationEnabled"
                            checked={form.registrationEnabled}
                            onChange={(e) => setForm({ ...form, registrationEnabled: e.target.checked })}
                            className={checkboxClass}
                        />
                        <label htmlFor="registrationEnabled" className="text-sm ui-text">
                            Izinkan Registrasi Member Baru
                        </label>
                    </div>
                    <div className="flex items-center gap-3">
                        <input
                            type="checkbox"
                            id="guestCheckoutEnabled"
                            checked={form.guestCheckoutEnabled}
                            onChange={(e) => setForm({ ...form, guestCheckoutEnabled: e.target.checked })}
                            className={checkboxClass}
                        />
                        <label htmlFor="guestCheckoutEnabled" className="text-sm ui-text">
                            Izinkan Transaksi Tanpa Login (Guest)
                        </label>
                    </div>
                </div>
            </div>

            <div className="ui-panel-muted rounded-lg p-4 border ui-border">
                <h3 className="text-sm font-semibold ui-accent-text mb-3">Pengaturan Deposit</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                        <label className={labelClass}>Minimum Deposit</label>
                        <input
                            type="number"
                            className={inputClass}
                            value={form.minDeposit}
                            onChange={(e) => setForm({ ...form, minDeposit: parseIntegerInput(e.target.value) })}
                        />
                    </div>
                    <div>
                        <label className={labelClass}>Maximum Deposit</label>
                        <input
                            type="number"
                            className={inputClass}
                            value={form.maxDeposit}
                            onChange={(e) => setForm({ ...form, maxDeposit: parseIntegerInput(e.target.value) })}
                        />
                    </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
                    <div>
                        <label className={labelClass}>Biaya Admin Deposit</label>
                        <input
                            type="number"
                            className={inputClass}
                            value={form.depositFee}
                            onChange={(e) => setForm({ ...form, depositFee: parseIntegerInput(e.target.value) })}
                        />
                    </div>
                    <div>
                        <label className={labelClass}>Tipe Biaya</label>
                        <select
                            className={inputClass}
                            value={form.depositFeeType}
                            onChange={(e) => setForm({ ...form, depositFeeType: e.target.value as 'fixed' | 'percent' })}
                        >
                            <option value="fixed">Nominal Tetap (Rp)</option>
                            <option value="percent">Persentase (%)</option>
                        </select>
                    </div>
                </div>
            </div>
        </div>
    );

    const renderOtherTab = () => (
        <div className="space-y-4">
            <div>
                <label className={labelClass}>Teks Footer</label>
                <input
                    className={inputClass}
                    value={form.footerText}
                    onChange={(e) => setForm({ ...form, footerText: e.target.value })}
                    placeholder="© 2025 Brand. All Rights Reserved."
                />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                    <label className={labelClass}>URL Syarat & Ketentuan</label>
                    <input
                        className={inputClass}
                        value={form.termsUrl}
                        onChange={(e) => setForm({ ...form, termsUrl: e.target.value })}
                        placeholder="https://example.com/terms"
                    />
                </div>
                <div>
                    <label className={labelClass}>URL Kebijakan Privasi</label>
                    <input
                        className={inputClass}
                        value={form.privacyUrl}
                        onChange={(e) => setForm({ ...form, privacyUrl: e.target.value })}
                        placeholder="https://example.com/privacy"
                    />
                </div>
            </div>
            <div className="ui-panel-muted rounded-lg p-4 border ui-border">
                <h3 className="text-sm font-semibold ui-accent-text mb-3">Analytics & Tracking</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                        <label className={labelClass}>Google Analytics ID</label>
                        <input
                            className={inputClass}
                            value={form.googleAnalyticsId}
                            onChange={(e) => setForm({ ...form, googleAnalyticsId: e.target.value })}
                            placeholder="G-XXXXXXXXXX"
                        />
                    </div>
                    <div>
                        <label className={labelClass}>Facebook Pixel ID</label>
                        <input
                            className={inputClass}
                            value={form.facebookPixelId}
                            onChange={(e) => setForm({ ...form, facebookPixelId: e.target.value })}
                            placeholder="1234567890"
                        />
                    </div>
                </div>
            </div>
        </div>
    );

    const renderBannerTab = () => (
        <div className="space-y-4">
            <div className="flex items-center gap-3 mb-4">
                <input
                    type="checkbox"
                    id="popupBannerEnabled"
                    checked={form.popupBannerEnabled}
                    onChange={(e) => setForm({ ...form, popupBannerEnabled: e.target.checked })}
                    className={checkboxClass}
                />
                <label htmlFor="popupBannerEnabled" className="text-sm ui-text">
                    Aktifkan Popup Banner
                </label>
            </div>

            {form.popupBannerEnabled && (
                <>
                    <div>
                        <label className={labelClass}>Gambar Banner</label>
                        <ImagePickerField
                            value={form.popupBannerImage}
                            onChange={(url: string) => setForm({ ...form, popupBannerImage: url })}
                            folder="popups"
                        />
                    </div>
                    <div>
                        <label className={labelClass}>Judul Banner</label>
                        <input
                            className={inputClass}
                            value={form.popupBannerTitle}
                            onChange={(e) => setForm({ ...form, popupBannerTitle: e.target.value })}
                            placeholder="Promo Spesial!"
                        />
                    </div>
                    <div>
                        <label className={labelClass}>Deskripsi Banner</label>
                        <textarea
                            className={inputClass}
                            value={form.popupBannerDescription}
                            onChange={(e) => setForm({ ...form, popupBannerDescription: e.target.value })}
                            rows={2}
                            placeholder="Dapatkan diskon hingga 50%..."
                        />
                    </div>
                    <div>
                        <label className={labelClass}>Link Banner (opsional)</label>
                        <input
                            className={inputClass}
                            value={form.popupBannerLink}
                            onChange={(e) => setForm({ ...form, popupBannerLink: e.target.value })}
                            placeholder="https://example.com/promo"
                        />
                    </div>
                </>
            )}
        </div>
    );

    const generateSampleRefId = (prefix: string, dateFormat: string, separator: string, seqDigits: number) => {
        const now = new Date();
        const dd = String(now.getDate()).padStart(2, '0');
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const yyyy = String(now.getFullYear());
        const yy = yyyy.slice(2);
        let datePart = '';
        switch (dateFormat) {
            case 'DDMMYYYY': datePart = `${dd}${mm}${yyyy}`; break;
            case 'YYYYMMDD': datePart = `${yyyy}${mm}${dd}`; break;
            case 'MMDDYYYY': datePart = `${mm}${dd}${yyyy}`; break;
            case 'DDMMYY': datePart = `${dd}${mm}${yy}`; break;
            case 'YYMMDD': datePart = `${yy}${mm}${dd}`; break;
            case 'NONE': datePart = ''; break;
            default: datePart = `${dd}${mm}${yyyy}`;
        }
        const seq = '0'.repeat(Math.max(1, seqDigits) - 1) + '1';
        const parts = [prefix, datePart, seq].filter(Boolean);
        return parts.join(separator);
    };

    const generateSampleInvoice = (prefix: string, dateFormat: string, separator: string, randomLen: number, randomType: string) => {
        const now = new Date();
        const dd = String(now.getDate()).padStart(2, '0');
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const yyyy = String(now.getFullYear());
        const yy = yyyy.slice(2);
        let datePart = '';
        switch (dateFormat) {
            case 'DDMMYYYY': datePart = `${dd}${mm}${yyyy}`; break;
            case 'YYYYMMDD': datePart = `${yyyy}${mm}${dd}`; break;
            case 'MMDDYYYY': datePart = `${mm}${dd}${yyyy}`; break;
            case 'DDMMYY': datePart = `${dd}${mm}${yy}`; break;
            case 'YYMMDD': datePart = `${yy}${mm}${dd}`; break;
            case 'NONE': datePart = ''; break;
            default: datePart = `${yyyy}${mm}${dd}`;
        }
        let random = '';
        const len = Math.max(1, randomLen);
        if (randomType === 'numeric') {
            random = invoicePreviewSeed.replace(/\D/g, '').padEnd(len, '0').slice(0, len);
        } else {
            random = invoicePreviewSeed.padEnd(len, 'A').slice(0, len);
        }
        const parts = [prefix, datePart, random].filter(Boolean);
        return parts.join(separator);
    };

    const renderRefIdTab = () => (
        <div className="space-y-6">
            {/* Ref ID Config */}
            <div className="ui-panel-muted rounded-lg p-4 border ui-border">
                <h3 className="text-sm font-semibold ui-accent-text mb-1">Format Ref ID (Transaksi Saldo)</h3>
                <p className="text-xs ui-text-muted mb-4">Ref ID digunakan sebagai referensi untuk transaksi via saldo member.</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                        <label className={labelClass}>Prefix</label>
                        <input
                            className={inputClass}
                            value={form.refIdPrefix}
                            onChange={(e) => setForm({ ...form, refIdPrefix: e.target.value.toUpperCase() })}
                            placeholder="REF"
                        />
                        <p className="text-xs ui-text-muted mt-1">Awalan Ref ID, contoh: REF, TRX, ORD</p>
                    </div>
                    <div>
                        <label className={labelClass}>Format Tanggal</label>
                        <select
                            className={inputClass}
                            value={form.refIdDateFormat}
                            onChange={(e) => setForm({ ...form, refIdDateFormat: e.target.value })}
                        >
                            <option value="DDMMYYYY">DDMMYYYY (29012026)</option>
                            <option value="YYYYMMDD">YYYYMMDD (20260129)</option>
                            <option value="MMDDYYYY">MMDDYYYY (01292026)</option>
                            <option value="DDMMYY">DDMMYY (290126)</option>
                            <option value="YYMMDD">YYMMDD (260129)</option>
                            <option value="NONE">Tanpa Tanggal</option>
                        </select>
                    </div>
                    <div>
                        <label className={labelClass}>Separator</label>
                        <select
                            className={inputClass}
                            value={form.refIdSeparator}
                            onChange={(e) => setForm({ ...form, refIdSeparator: e.target.value })}
                        >
                            <option value="">Tanpa Separator</option>
                            <option value="-">Dash (-)</option>
                            <option value="_">Underscore (_)</option>
                        </select>
                    </div>
                    <div>
                        <label className={labelClass}>Jumlah Digit Sequence</label>
                        <input
                            type="number"
                            className={inputClass}
                            value={form.refIdSequenceDigits}
                            onChange={(e) => setForm({ ...form, refIdSequenceDigits: Math.max(1, Math.min(10, parseInt(e.target.value) || 4)) })}
                            min={1}
                            max={10}
                        />
                        <p className="text-xs ui-text-muted mt-1">Jumlah digit urutan harian (1-10)</p>
                    </div>
                </div>
                <div className="mt-4 p-3 ui-panel rounded-lg border ui-border">
                    <div className="flex items-center justify-between">
                        <span className="text-xs ui-text-muted">Preview:</span>
                        <span className="text-sm font-mono font-bold ui-success-text">
                            {generateSampleRefId(form.refIdPrefix, form.refIdDateFormat, form.refIdSeparator, form.refIdSequenceDigits)}
                        </span>
                    </div>
                </div>
            </div>

            {/* Invoice Config */}
            <div className="ui-panel-muted rounded-lg p-4 border ui-border">
                <h3 className="text-sm font-semibold ui-accent-text mb-1">Format Invoice (Transaksi Gateway)</h3>
                <p className="text-xs ui-text-muted mb-4">Invoice digunakan sebagai nomor unik untuk transaksi via payment gateway / transfer bank.</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                        <label className={labelClass}>Prefix</label>
                        <input
                            className={inputClass}
                            value={form.invoicePrefix}
                            onChange={(e) => setForm({ ...form, invoicePrefix: e.target.value.toUpperCase() })}
                            placeholder="INV"
                        />
                        <p className="text-xs ui-text-muted mt-1">Awalan Invoice, contoh: INV, PAY, BIL</p>
                    </div>
                    <div>
                        <label className={labelClass}>Format Tanggal</label>
                        <select
                            className={inputClass}
                            value={form.invoiceDateFormat}
                            onChange={(e) => setForm({ ...form, invoiceDateFormat: e.target.value })}
                        >
                            <option value="DDMMYYYY">DDMMYYYY (29012026)</option>
                            <option value="YYYYMMDD">YYYYMMDD (20260129)</option>
                            <option value="MMDDYYYY">MMDDYYYY (01292026)</option>
                            <option value="DDMMYY">DDMMYY (290126)</option>
                            <option value="YYMMDD">YYMMDD (260129)</option>
                            <option value="NONE">Tanpa Tanggal</option>
                        </select>
                    </div>
                    <div>
                        <label className={labelClass}>Separator</label>
                        <select
                            className={inputClass}
                            value={form.invoiceSeparator}
                            onChange={(e) => setForm({ ...form, invoiceSeparator: e.target.value })}
                        >
                            <option value="">Tanpa Separator</option>
                            <option value="-">Dash (-)</option>
                            <option value="_">Underscore (_)</option>
                        </select>
                    </div>
                    <div>
                        <label className={labelClass}>Panjang Random</label>
                        <input
                            type="number"
                            className={inputClass}
                            value={form.invoiceRandomLength}
                            onChange={(e) => setForm({ ...form, invoiceRandomLength: Math.max(1, Math.min(12, parseInt(e.target.value) || 6)) })}
                            min={1}
                            max={12}
                        />
                        <p className="text-xs ui-text-muted mt-1">Jumlah karakter random (1-12)</p>
                    </div>
                    <div>
                        <label className={labelClass}>Tipe Random</label>
                        <select
                            className={inputClass}
                            value={form.invoiceRandomType}
                            onChange={(e) => setForm({ ...form, invoiceRandomType: e.target.value })}
                        >
                            <option value="alphanumeric">Huruf & Angka (A-Z, 0-9)</option>
                            <option value="numeric">Angka saja (0-9)</option>
                        </select>
                    </div>
                </div>
                <div className="mt-4 p-3 ui-panel rounded-lg border ui-border">
                    <div className="flex items-center justify-between">
                        <span className="text-xs ui-text-muted">Preview:</span>
                        <span className="text-sm font-mono font-bold ui-success-text">
                            {generateSampleInvoice(form.invoicePrefix, form.invoiceDateFormat, form.invoiceSeparator, form.invoiceRandomLength, form.invoiceRandomType)}
                        </span>
                    </div>
                </div>
            </div>
        </div>
    );

    const renderTabContent = () => {
        switch (activeTab) {
            case 'web': return renderWebTab();
            case 'contact': return renderContactTab();
            case 'system': return renderSystemTab();
            case 'other': return renderOtherTab();
            case 'banner': return renderBannerTab();
            case 'refid': return renderRefIdTab();
            default: return null;
        }
    };

    return (
        <div className="space-y-5">
            {message && (
                <div className={`rounded-xl border px-4 py-3 text-sm ${
                    message.type === 'success'
                        ? 'ui-success-chip'
                        : 'ui-danger-chip'
                }`}>
                    <div className="flex items-start justify-between gap-3">
                        <span>{message.text}</span>
                        <button type="button" onClick={() => setMessage(null)} className="font-black">×</button>
                    </div>
                </div>
            )}

            <div className="ui-panel-muted rounded-xl border ui-border">
                <div className="overflow-x-auto border-b ui-border">
                    <div className="flex min-w-full">
                        {tabs.map((tab) => (
                            <button
                                key={tab.key}
                                onClick={() => setActiveTab(tab.key)}
                                className={`px-4 py-3 text-sm font-semibold border-r ui-border whitespace-nowrap ${
                                    activeTab === tab.key ? 'ui-accent-chip ui-accent-text' : 'ui-text-muted hover:bg-[var(--ui-card-muted)]'
                                }`}
                            >
                                {tab.label}
                            </button>
                        ))}
                    </div>
                </div>

                <div className="p-4 ui-text min-h-[300px]">
                    {loading ? (
                        <div className="flex items-center justify-center py-12">
                            <Loader2 className="w-8 h-8 ui-accent-text animate-spin" />
                        </div>
                    ) : (
                        <div className="space-y-4">
                            {activeTab === 'system' && (
                                <div className="rounded-xl border p-4 text-sm ui-warning-chip">
                                    <div className="flex items-start gap-3">
                                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 ui-warning-text" />
                                        <p>
                                            Toggle registrasi, guest checkout, maintenance, dan biaya deposit sekarang sudah ditegakkan di backend.
                                            Perubahan akan berdampak langsung ke flow publik setelah disimpan.
                                        </p>
                                    </div>
                                </div>
                            )}
                            {renderTabContent()}
                        </div>
                    )}
                </div>

                <div className="p-4 border-t ui-border flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="text-xs ui-text-muted">
                        Hanya pengguna dengan izin `manageSettings` yang bisa melihat dan mengubah halaman ini.
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={fetchSettings}
                            disabled={saving || loading}
                            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border ui-muted-action text-sm font-semibold hover:border-[var(--ui-accent)] transition-colors disabled:opacity-50"
                        >
                            <RefreshCcw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                            Segarkan
                        </button>
                        <button
                            onClick={() => handleSave()}
                            disabled={saving || loading}
                            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg ui-accent-solid text-sm font-semibold transition-colors disabled:opacity-50"
                        >
                            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                            {saving ? 'Menyimpan...' : 'Simpan'}
                        </button>
                    </div>
                </div>
            </div>

            {pendingConfirmMessage && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
                    <div className="ui-panel ui-border w-full max-w-xl rounded-3xl border p-6 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="site-config-confirm-title">
                        <h2 id="site-config-confirm-title" className="ui-text text-xl font-black">Konfirmasi perubahan sensitif</h2>
                        <p className="ui-text-muted mt-3 text-sm leading-relaxed">{pendingConfirmMessage}</p>
                        <p className="ui-text-muted mt-2 text-sm">Pastikan perubahan ini memang diinginkan sebelum menyimpan.</p>
                        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-end">
                            <button type="button" disabled={saving} onClick={() => setPendingConfirmMessage(null)} className="ui-muted-action rounded-xl px-4 py-3 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-60">Batal</button>
                            <button type="button" disabled={saving} onClick={() => handleSave(true)} className="ui-warning-action inline-flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-60">
                                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                                Simpan perubahan
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
