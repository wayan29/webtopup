import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
    Bell,
    Check,
    Code,
    Copy,
    Eye,
    EyeOff,
    Key,
    Loader2,
    Moon,
    RefreshCw,
    Save,
    Shield,
    Sun,
    Trash2
} from 'lucide-react';
import { apiV2 } from '../api';
import { useAuthStore } from '../store/useAuthStore';
import {
    buildOpenApiBaseUrl,
    canCopyOpenApiSecret,
    maskOpenApiKey,
    OPEN_API_ENDPOINTS,
    OPEN_API_LIST_SIGNATURE,
    OPEN_API_ORDER_SIGNATURE,
    openApiCurlExamples,
    openApiSecretStatus,
    parseSettingsTab,
    type SettingsTabId,
} from '../lib/openApiSettings';
import { DARK_UI_THEME, LIGHT_UI_THEME, UI_THEME_OPTIONS, getUIThemeMeta, type UIThemeId } from '../lib/uiTheme';

type PreferencesResponse = {
    preferences: {
        emailNotifications: boolean;
        smsNotifications: boolean;
        showBalance: boolean;
        uiTheme: UIThemeId;
    };
};

export default function Settings() {
    const { user, syncProfile } = useAuthStore();
    const [searchParams, setSearchParams] = useSearchParams();
    const activeTab: SettingsTabId = parseSettingsTab(searchParams.get('tab'));
    const setActiveTab = (next: SettingsTabId) => {
        setSearchParams(next === 'preferences' ? {} : { tab: next }, { replace: true });
    };
    const [loading, setLoading] = useState(false);
    const [settingsLoading, setSettingsLoading] = useState(true);
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
    const [settings, setSettings] = useState({
        emailNotifications: true,
        smsNotifications: false,
        twoFactorAuth: false,
        showBalance: true,
        uiTheme: 'ember-premium' as UIThemeId
    });

    const [memberId, setMemberId] = useState<string | null>(null);
    const [apiKey, setApiKey] = useState<string | null>(null);
    /** One-time plaintext secret from generate only; never reloaded from GET /api/key. */
    const [apiSecret, setApiSecret] = useState<string | null>(null);
    const [hasStoredSecret, setHasStoredSecret] = useState(false);
    const [apiLoading, setApiLoading] = useState(true);
    const [apiGenerating, setApiGenerating] = useState(false);
    const [copied, setCopied] = useState<string | null>(null);
    const [showApiKey, setShowApiKey] = useState(false);
    const [showDocs, setShowDocs] = useState(false);
    const [pendingApiAction, setPendingApiAction] = useState<null | 'regenerate' | 'revoke'>(null);

    useEffect(() => {
        const loadSettingsPage = async () => {
            try {
                setSettingsLoading(true);
                setApiLoading(true);
                const [preferencesRes, apiKeyRes] = await Promise.all([
                    apiV2.get<PreferencesResponse>('/users/me/preferences'),
                    apiV2.get('/api/key')
                ]);

                const nextPreferences = preferencesRes.data.preferences;
                setSettings({
                    emailNotifications: nextPreferences.emailNotifications !== false,
                    smsNotifications: nextPreferences.smsNotifications === true,
                    twoFactorAuth: false,
                    showBalance: nextPreferences.showBalance !== false,
                    uiTheme: nextPreferences.uiTheme || 'ember-premium'
                });
                setMemberId(apiKeyRes.data.memberId || null);
                setApiKey(apiKeyRes.data.apiKey || null);
                // GET never returns secret plaintext; only whether one is stored.
                setApiSecret(null);
                setHasStoredSecret(Boolean(apiKeyRes.data.hasSecret));
            } catch (error) {
                console.error('Failed to load settings page', error);
                setMessage({ type: 'error', text: 'Gagal memuat pengaturan akun.' });
            } finally {
                setSettingsLoading(false);
                setApiLoading(false);
            }
        };

        void loadSettingsPage();
    }, []);

    const generateApiKey = async () => {
        try {
            setApiGenerating(true);
            setMessage(null);
            const res = await apiV2.post('/api/key/generate');
            setMemberId(res.data.memberId || null);
            setApiKey(res.data.apiKey);
            setApiSecret(res.data.secret || null);
            setHasStoredSecret(Boolean(res.data.secret));
            setShowApiKey(true);
            setMessage({
                type: 'success',
                text: 'API key berhasil dibuat. Salin Secret sekarang — tidak ditampilkan lagi setelah reload.',
            });
        } catch (error) {
            console.error('Failed to generate API key', error);
            setMessage({ type: 'error', text: 'Gagal membuat API key.' });
        } finally {
            setApiGenerating(false);
        }
    };

    const revokeApiKey = async () => {
        try {
            setMessage(null);
            await apiV2.delete('/api/key/revoke');
            setApiKey(null);
            setApiSecret(null);
            setHasStoredSecret(false);
            setShowApiKey(false);
            setMessage({ type: 'success', text: 'API key berhasil dihapus.' });
        } catch (error) {
            console.error('Failed to revoke API key', error);
            setMessage({ type: 'error', text: 'Gagal menghapus API key.' });
        }
    };

    const copyValue = async (value: string | null | undefined, key: string) => {
        if (!value) return;
        try {
            await navigator.clipboard.writeText(value);
            setCopied(key);
            setTimeout(() => setCopied(null), 2000);
        } catch {
            setMessage({ type: 'error', text: 'Gagal menyalin ke clipboard.' });
        }
    };

    const requestGenerateApiKey = () => {
        if (apiKey) {
            setPendingApiAction('regenerate');
            return;
        }
        void generateApiKey();
    };

    const requestRevokeApiKey = () => setPendingApiAction('revoke');

    const confirmPendingApiAction = async () => {
        const action = pendingApiAction;
        setPendingApiAction(null);
        if (action === 'regenerate') await generateApiKey();
        if (action === 'revoke') await revokeApiKey();
    };

    const handleSave = async () => {
        setLoading(true);
        setMessage(null);

        try {
            const payload = {
                emailNotifications: settings.emailNotifications,
                smsNotifications: settings.smsNotifications,
                showBalance: settings.showBalance,
                uiTheme: settings.uiTheme
            };
            const res = await apiV2
                .put<PreferencesResponse>('/users/me/preferences', payload);

            const nextPreferences = res.data.preferences;
            setSettings((current) => ({
                ...current,
                emailNotifications: nextPreferences.emailNotifications !== false,
                smsNotifications: nextPreferences.smsNotifications === true,
                showBalance: nextPreferences.showBalance !== false,
                uiTheme: nextPreferences.uiTheme || 'ember-premium'
            }));
            setMessage({ type: 'success', text: 'Preferensi berhasil disimpan.' });
            await syncProfile();
        } catch (error: any) {
            setMessage({
                type: 'error',
                text: error.response?.data?.message || 'Gagal menyimpan preferensi.'
            });
        } finally {
            setLoading(false);
        }
    };

    const secretStatus = openApiSecretStatus({ plaintext: apiSecret, hasStoredSecret });
    const secretDisplay = secretStatus === 'visible'
        ? apiSecret
        : secretStatus === 'stored-hidden'
            ? 'Tersimpan (hanya ditampilkan saat generate)'
            : '-';
    const rawApiV2Base = import.meta.env.VITE_API_V2_URL || '/api/v2';
    const activeTheme = getUIThemeMeta(settings.uiTheme);
    const openApiBaseUrl = useMemo(
        () => buildOpenApiBaseUrl(rawApiV2Base, window.location.origin),
        [rawApiV2Base],
    );

    return (
        <div className="space-y-6 animate-slide-up">
            {/* Elegant Premium Header */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b ui-border">
                <div>
                    <h1 className="text-2xl font-black tracking-tight ui-text sm:text-3xl bg-gradient-to-r from-orange-400 via-amber-500 to-pink-500 bg-clip-text text-transparent">
                        Pengaturan Akun
                    </h1>
                    <p className="text-sm ui-text-muted mt-1">
                        Kelola tema personal, preferensi notifikasi, dan akses Open API developer kamu.
                    </p>
                </div>
                {user?.preferences && (
                    <div className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-full ui-panel-muted border ui-border text-xs ui-text-muted shadow-sm">
                        <span className="h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" />
                        Tema aktif: <strong className="ui-text">{getUIThemeMeta(user.preferences.uiTheme).label}</strong>
                    </div>
                )}
            </div>

            {/* Message Notification Banner */}
            {message && (
                <div className={`rounded-xl border px-4 py-3 text-sm flex items-center gap-3 animate-slide-up ${
                    message.type === 'success' ? 'ui-success-chip' : 'ui-danger-chip'
                }`}>
                    <span className={`h-2 w-2 rounded-full shrink-0 ${message.type === 'success' ? 'bg-green-500' : 'bg-red-500'}`} />
                    <span className="font-semibold">{message.text}</span>
                </div>
            )}

            {/* Sliding Pill Tab Navigation */}
            <div className="flex w-full min-w-0 gap-1 rounded-xl border ui-border bg-black/10 p-1" role="tablist" aria-label="Pengaturan akun">
                <button
                    type="button"
                    role="tab"
                    aria-selected={activeTab === 'preferences'}
                    onClick={() => setActiveTab('preferences')}
                    className={`min-w-0 flex-1 flex items-center justify-center gap-1 sm:gap-2 px-2 sm:px-4 py-2.5 rounded-lg text-xs sm:text-sm font-semibold transition-all ${
                        activeTab === 'preferences'
                            ? 'ui-accent-chip shadow-sm'
                            : 'ui-text-muted hover:ui-text hover:bg-white/5'
                    }`}
                >
                    <Sun className="h-4 w-4 shrink-0" />
                    <span className="hidden sm:inline">Tampilan & Preferensi</span>
                    <span className="sm:hidden">Preferensi</span>
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={activeTab === 'api'}
                    onClick={() => setActiveTab('api')}
                    className={`min-w-0 flex-1 flex items-center justify-center gap-1 sm:gap-2 px-2 sm:px-4 py-2.5 rounded-lg text-xs sm:text-sm font-semibold transition-all ${
                        activeTab === 'api'
                            ? 'ui-accent-chip shadow-sm'
                            : 'ui-text-muted hover:ui-text hover:bg-white/5'
                    }`}
                >
                    <Code className="h-4 w-4 shrink-0" />
                    <span className="hidden sm:inline">Open API</span>
                    <span className="sm:hidden">API</span>
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={activeTab === 'security'}
                    onClick={() => setActiveTab('security')}
                    className={`min-w-0 flex-1 flex items-center justify-center gap-1 sm:gap-2 px-2 sm:px-4 py-2.5 rounded-lg text-xs sm:text-sm font-semibold transition-all ${
                        activeTab === 'security'
                            ? 'ui-accent-chip shadow-sm'
                            : 'ui-text-muted hover:ui-text hover:bg-white/5'
                    }`}
                >
                    <Shield className="h-4 w-4 shrink-0" />
                    Keamanan
                </button>
            </div>

            {/* TAB CONTENT AREAS */}

            {activeTab === 'preferences' && (
                <div role="tabpanel" className="space-y-6 animate-slide-up">
                    {/* UI Theme Selection Panel */}
                    <div className="ui-panel rounded-2xl p-6 border ui-border space-y-6">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-xl ui-accent-chip flex items-center justify-center">
                                <Moon className="w-5 h-5" />
                            </div>
                            <div>
                                <h2 className="text-lg font-bold ui-text">Preset & Tema Area Member</h2>
                                <p className="text-xs ui-text-muted">Ubah nuansa visual panel pribadi kamu secara instan.</p>
                            </div>
                        </div>

                        {/* Mode Malam / Terang Presets */}
                        <div className="grid gap-3 sm:grid-cols-2">
                            <button
                                type="button"
                                onClick={() => setSettings((current) => ({ ...current, uiTheme: DARK_UI_THEME }))}
                                className={`flex items-center justify-center gap-2 rounded-xl border px-4 py-3 text-sm font-semibold transition-all ${
                                    settings.uiTheme === DARK_UI_THEME
                                        ? 'ui-accent-chip shadow-md'
                                        : 'ui-muted-action'
                                }`}
                            >
                                <Moon className="h-4 w-4" />
                                Preset Mode Gelap
                            </button>
                            <button
                                type="button"
                                onClick={() => setSettings((current) => ({ ...current, uiTheme: LIGHT_UI_THEME }))}
                                className={`flex items-center justify-center gap-2 rounded-xl border px-4 py-3 text-sm font-semibold transition-all ${
                                    settings.uiTheme === LIGHT_UI_THEME
                                        ? 'ui-accent-chip shadow-md'
                                        : 'ui-muted-action'
                                }`}
                            >
                                <Sun className="h-4 w-4" />
                                Preset Mode Terang
                            </button>
                        </div>

                        {/* Grid of UI_THEME_OPTIONS */}
                        <div className="space-y-3">
                            <label className="text-sm font-bold ui-text block">Galeri Tema Eksklusif</label>
                            {settingsLoading ? (
                                <div className="flex items-center justify-center py-8">
                                    <Loader2 className="w-6 h-6 text-orange-500 animate-spin" />
                                </div>
                            ) : (
                                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                                    {UI_THEME_OPTIONS.map((theme) => {
                                        const isActive = settings.uiTheme === theme.id;
                                        
                                        let accentDot = 'bg-orange-500';
                                        if (theme.id.includes('forest')) accentDot = 'bg-emerald-500';
                                        else if (theme.id.includes('royal')) accentDot = 'bg-purple-500';
                                        else if (theme.id.includes('graphite')) accentDot = 'bg-zinc-500';
                                        else if (theme.id.includes('horizon')) accentDot = 'bg-blue-500';
                                        else if (theme.id.includes('midnight')) accentDot = 'bg-indigo-500';
                                        else if (theme.id.includes('neobrutal')) accentDot = 'bg-red-500';

                                        return (
                                            <button
                                                key={theme.id}
                                                type="button"
                                                onClick={() => setSettings((current) => ({ ...current, uiTheme: theme.id }))}
                                                className={`ui-panel rounded-xl border p-4 text-left transition-all relative overflow-hidden flex flex-col justify-between min-h-[160px] ${
                                                    isActive
                                                        ? 'ui-neon-pulse border-2 shadow-lg ring-1 ring-orange-500/20'
                                                        : 'ui-hover-glow hover:bg-[var(--ui-card-muted)]'
                                                }`}
                                            >
                                                <div className="flex items-start justify-between gap-3 w-full">
                                                    <div className="flex items-center gap-2">
                                                        <span className={`h-2.5 w-2.5 rounded-full ${accentDot}`} />
                                                        <p className="text-sm font-bold ui-text">{theme.label}</p>
                                                    </div>
                                                    {isActive && (
                                                        <span className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ui-success-chip shrink-0">
                                                            Aktif
                                                        </span>
                                                    )}
                                                </div>
                                                
                                                <div className="mt-2 flex-1">
                                                    <p className={`text-[9px] font-bold uppercase tracking-widest ${isActive ? 'ui-accent-text' : 'ui-text-muted'}`}>
                                                        {theme.tagline}
                                                    </p>
                                                    <p className="mt-1 text-xs leading-normal ui-text-muted line-clamp-3">
                                                        {theme.description}
                                                    </p>
                                                </div>

                                                <div className="mt-3 pt-2 border-t ui-border w-full flex justify-between items-center text-[10px] ui-text-muted">
                                                    <span>Target Pengguna</span>
                                                    <span className="font-semibold truncate max-w-[150px]">{theme.audience.replace('Cocok untuk ', '')}</span>
                                                </div>
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                        </div>

                        {/* Theme Active Display Card */}
                        <div className="rounded-xl border ui-border ui-panel-muted p-4 flex items-center justify-between gap-4">
                            <div className="space-y-1">
                                <p className="text-[10px] font-bold uppercase tracking-widest ui-text-muted">Tema yang sedang diterapkan</p>
                                <p className="text-base font-extrabold ui-text">{activeTheme.label}</p>
                                <p className="text-xs ui-text-muted">{activeTheme.description}</p>
                            </div>
                            <div className="h-12 w-12 rounded-xl ui-accent-solid flex items-center justify-center text-lg font-black shadow-md shrink-0 select-none">
                                {activeTheme.label.charAt(0)}
                            </div>
                        </div>
                    </div>

                    {/* Preference Settings Toggles */}
                    <div className="ui-panel rounded-2xl p-6 border ui-border space-y-4">
                        <div className="flex items-center gap-3 mb-2">
                            <div className="w-10 h-10 rounded-xl ui-accent-chip flex items-center justify-center">
                                <Bell className="w-5 h-5 animate-pulse" />
                            </div>
                            <div>
                                <h2 className="text-lg font-bold ui-text">Preferensi Layanan</h2>
                                <p className="text-xs ui-text-muted">Tentukan jalur komunikasi dan opsi privasi untuk akun Anda.</p>
                            </div>
                        </div>

                        {settingsLoading ? (
                            <div className="flex items-center justify-center py-8">
                                <Loader2 className="w-6 h-6 text-orange-500 animate-spin" />
                            </div>
                        ) : (
                            <div className="divide-y ui-border">
                                <PreferenceToggle
                                    title="Notifikasi Email"
                                    description="Dapatkan ringkasan transaksi, invoice, dan pengingat lewat email secara instan."
                                    checked={settings.emailNotifications}
                                    onChange={(checked) => setSettings((current) => ({ ...current, emailNotifications: checked }))}
                                />
                                <PreferenceToggle
                                    title="Notifikasi SMS"
                                    description="Dapatkan konfirmasi transaksi secara singkat langsung ke ponsel Anda."
                                    checked={settings.smsNotifications}
                                    onChange={(checked) => setSettings((current) => ({ ...current, smsNotifications: checked }))}
                                />
                                <PreferenceToggle
                                    title="Tampilkan Saldo di Dashboard"
                                    description="Sembunyikan atau samarkan nilai saldo Anda di halaman utama untuk privasi tambahan."
                                    checked={settings.showBalance}
                                    onChange={(checked) => setSettings((current) => ({ ...current, showBalance: checked }))}
                                    withBorder={false}
                                />
                            </div>
                        )}
                    </div>

                    {/* Save Action Bar */}
                    <div className="flex justify-end pt-2">
                        <button
                            type="button"
                            onClick={handleSave}
                            disabled={loading || settingsLoading}
                            className="bg-orange-500 hover:bg-orange-600 text-white px-6 py-3 rounded-xl font-bold text-sm transition-all shadow-md flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {loading ? (
                                <>
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                    Menyimpan Preferensi...
                                </>
                            ) : (
                                <>
                                    <Save className="w-4 h-4" />
                                    Simpan Perubahan Preferensi
                                </>
                            )}
                        </button>
                    </div>
                </div>
            )}

            {activeTab === 'api' && (
                <div role="tabpanel" className="space-y-6 animate-slide-up">
                    {/* API Key Panel */}
                    <div className="ui-panel rounded-2xl p-6 border ui-border space-y-6">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                            <div className="flex items-center gap-3">
                                <div className="w-10 h-10 rounded-xl ui-accent-chip flex items-center justify-center">
                                    <Key className="w-5 h-5" />
                                </div>
                                <div>
                                    <h2 className="text-lg font-bold ui-text">Kredensial Open API</h2>
                                    <p className="text-xs ui-text-muted">Gunakan kredensial ini untuk otomasi transaksi lewat API.</p>
                                </div>
                            </div>
                        </div>

                        {apiLoading ? (
                            <div className="flex flex-col items-center justify-center py-12 space-y-2">
                                <Loader2 className="w-8 h-8 ui-accent-text animate-spin" />
                                <p className="text-xs ui-text-muted">Memuat kredensial API...</p>
                            </div>
                        ) : (
                            <div className="space-y-6">
                                {apiKey ? (
                                    <>
                                        <div className="grid gap-4 grid-cols-1 lg:grid-cols-3">
                                            <CredentialCard
                                                label="Member ID"
                                                value={memberId || '-'}
                                                copied={copied === 'memberId'}
                                                onCopy={() => void copyValue(memberId, 'memberId')}
                                            />
                                            <CredentialCard
                                                label="API Key"
                                                value={showApiKey ? apiKey : maskOpenApiKey(apiKey)}
                                                copied={copied === 'apiKey'}
                                                onCopy={() => void copyValue(apiKey, 'apiKey')}
                                                action={(
                                                    <button
                                                        type="button"
                                                        onClick={() => setShowApiKey((current) => !current)}
                                                        className="ui-text-muted hover:ui-text transition-colors p-1"
                                                        aria-label="Toggle API Key visibility"
                                                    >
                                                        {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                                    </button>
                                                )}
                                            />
                                            <CredentialCard
                                                label="Secret Key"
                                                value={secretDisplay}
                                                copied={copied === 'secret'}
                                                copyDisabled={!canCopyOpenApiSecret(secretStatus)}
                                                onCopy={() => {
                                                    if (!canCopyOpenApiSecret(secretStatus)) return;
                                                    void copyValue(apiSecret, 'secret');
                                                }}
                                            />
                                        </div>
                                        {apiSecret ? (
                                            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">
                                                Secret di atas hanya terlihat sekali sekarang. Simpan di tempat aman sebelum meninggalkan halaman.
                                            </div>
                                        ) : null}

                                        {pendingApiAction && (
                                            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm" data-testid="settings-openapi-confirm">
                                                <p className="font-semibold">
                                                    {pendingApiAction === 'regenerate'
                                                        ? 'API key lama akan diganti. Secret baru hanya ditampilkan sekali. Lanjutkan?'
                                                        : 'API key dan secret akan dihapus dan tidak bisa digunakan lagi. Lanjutkan?'}
                                                </p>
                                                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                                                    <button type="button" className="ui-accent-solid rounded-xl px-4 py-2 text-sm font-bold" onClick={() => void confirmPendingApiAction()}>
                                                        Ya, lanjutkan
                                                    </button>
                                                    <button type="button" className="ui-muted-action rounded-xl px-4 py-2 text-sm font-bold" onClick={() => setPendingApiAction(null)}>
                                                        Batal
                                                    </button>
                                                </div>
                                            </div>
                                        )}

                                        <div className="flex flex-col sm:flex-row flex-wrap gap-3">
                                            <button
                                                type="button"
                                                onClick={requestGenerateApiKey}
                                                disabled={apiGenerating}
                                                className="w-full sm:flex-1 flex items-center justify-center gap-2 px-5 py-2.5 ui-muted-action text-sm font-bold rounded-xl transition-all disabled:opacity-50"
                                            >
                                                {apiGenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4 ui-accent-text" />}
                                                Buat ulang kredensial
                                            </button>
                                            <button
                                                type="button"
                                                onClick={requestRevokeApiKey}
                                                className="w-full sm:w-auto flex items-center justify-center gap-2 px-5 py-2.5 ui-danger-action text-sm font-bold rounded-xl transition-all"
                                            >
                                                <Trash2 className="w-4 h-4" />
                                                Cabut key
                                            </button>
                                        </div>
                                    </>
                                ) : (
                                    <div className="text-center py-12 border border-dashed ui-border rounded-xl space-y-4">
                                        <div className="mx-auto w-12 h-12 rounded-full ui-accent-soft flex items-center justify-center">
                                            <Key className="w-6 h-6 ui-accent-text" />
                                        </div>
                                        <div className="space-y-1 max-w-sm mx-auto">
                                            <p className="text-sm font-bold ui-text">Belum ada API Key Aktif</p>
                                            <p className="text-xs ui-text-muted">
                                                Generate kredensial API pertama Anda untuk mulai mengintegrasikan sistem transaksi otomatis.
                                            </p>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={requestGenerateApiKey}
                                            disabled={apiGenerating}
                                            className="inline-flex items-center gap-2 px-6 py-3 ui-accent-solid rounded-xl text-sm font-bold shadow-md transition-all hover:scale-[1.02] disabled:opacity-50"
                                        >
                                            {apiGenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Key className="w-4 h-4" />}
                                            Buat API Key & Secret
                                        </button>
                                    </div>
                                )}

                                <div className="rounded-xl border border-dashed ui-border p-4 bg-orange-500/5 text-xs text-orange-400/90 flex gap-3">
                                    <Shield className="w-5 h-5 shrink-0" />
                                    <p>
                                        <strong>PENTING:</strong> Kredensial API Key dan Secret Key bersifat sangat sensitif. Jangan pernah menyebarkan atau memasukkan kredensial ini di repositori public atau client-side code tanpa enkripsi.
                                    </p>
                                </div>
                            </div>
                        )}
                    </div>

                    <div className="ui-panel rounded-2xl border ui-border p-4 sm:p-6 space-y-4" data-testid="settings-openapi-docs-summary">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div className="min-w-0">
                                <h3 className="text-base font-bold ui-text">Dokumentasi Open API</h3>
                                <p className="text-xs ui-text-muted">Base URL dan formula signature. Contoh CURL tetap tertutup sampai dibuka.</p>
                            </div>
                            <button type="button" className="ui-muted-action inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold" onClick={() => setShowDocs((current) => !current)}>
                                {showDocs ? 'Tutup contoh CURL & endpoint' : 'Buka contoh CURL & endpoint'}
                            </button>
                        </div>
                        <div>
                            <p className="text-xs font-bold uppercase tracking-wider ui-text-muted">Base URL API</p>
                            <div className="mt-1 flex min-w-0 items-start gap-2 rounded-lg border ui-border bg-black/10 px-3 py-2">
                                <code className="min-w-0 flex-1 break-all font-mono text-xs ui-accent-text">{openApiBaseUrl}</code>
                                <button type="button" onClick={() => void copyValue(openApiBaseUrl, 'baseUrl')} className="shrink-0 p-1 ui-text-muted hover:ui-text" title="Salin Base URL">
                                    {copied === 'baseUrl' ? <Check className="h-4 w-4 text-green-400" /> : <Copy className="h-4 w-4" />}
                                </button>
                            </div>
                        </div>
                        <div className="space-y-2 rounded-xl border ui-border bg-black/10 p-3 font-mono text-[11px]">
                            <p>Katalog &amp; profil: <code className="ui-accent-text">{OPEN_API_LIST_SIGNATURE}</code></p>
                            <p>Order / cek status: <code className="ui-accent-text">{OPEN_API_ORDER_SIGNATURE}</code></p>
                        </div>
                    </div>

                    {showDocs && (
                        <div className="ui-panel rounded-2xl border ui-border p-4 sm:p-6 space-y-4" data-testid="settings-openapi-docs-examples">
                            <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-xl border ui-border ui-panel-muted p-4 font-mono text-[11px] leading-relaxed ui-text">
                                {openApiCurlExamples(openApiBaseUrl)}
                            </pre>
                            <div className="grid gap-4 sm:grid-cols-2">
                                {OPEN_API_ENDPOINTS.map((endpoint) => (
                                    <Endpoint key={`${endpoint.method}-${endpoint.path}`} {...endpoint} />
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {activeTab === 'security' && (
                <div role="tabpanel" className="space-y-6 animate-slide-up">
                    {/* Security Tab Content */}
                    <div className="ui-panel rounded-2xl p-6 border ui-border space-y-6">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-xl ui-accent-chip flex items-center justify-center">
                                <Shield className="w-5 h-5 animate-pulse" />
                            </div>
                            <div>
                                <h2 className="text-lg font-bold ui-text">Keamanan Tambahan</h2>
                                <p className="text-xs ui-text-muted">Kelola lapisan proteksi keamanan akun member Anda.</p>
                            </div>
                        </div>

                        <div className="rounded-xl border ui-border ui-panel-muted p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                            <div className="space-y-1">
                                <p className="text-sm font-bold ui-text">Two-Factor Authentication (2FA)</p>
                                <p className="text-xs ui-text-muted leading-relaxed">
                                    Mengamankan proses login dan transaksi dengan kode verifikasi sekali-pakai (OTP) tambahan dari aplikasi Google Authenticator.
                                </p>
                            </div>
                            <span className="rounded-full bg-orange-500/10 border border-orange-500/20 px-3 py-1 text-xs font-bold text-orange-400 shrink-0">
                                Coming Soon
                            </span>
                        </div>
                    </div>
                </div>
            )}

            {/* Account preferences summary at bottom */}
            {user?.preferences && (
                <p className="text-[11px] ui-text-muted pt-2 select-none">
                    Preferensi akun aktif saat ini: saldo dashboard {user.preferences.showBalance ? 'ditampilkan' : 'disamarkan'}, tema personal {getUIThemeMeta(user.preferences.uiTheme).label}.
                </p>
            )}
        </div>
    );
}

function CredentialCard({
    label,
    value,
    copied,
    onCopy,
    action,
    copyDisabled = false,
}: {
    label: string;
    value: string | null;
    copied: boolean;
    onCopy: () => void;
    action?: ReactNode;
    copyDisabled?: boolean;
}) {
    return (
        <div className="ui-panel-muted rounded-xl p-4 border ui-border space-y-2 shadow-sm">
            <div className="flex items-center justify-between">
                <span className="text-xs font-bold ui-text-muted uppercase tracking-wider">{label}</span>
                {action}
            </div>
            <div className="flex items-start gap-2 bg-black/10 rounded-lg p-1.5 border ui-border">
                <code className="min-w-0 flex-1 break-all whitespace-pre-wrap text-xs ui-accent-text font-mono px-2 leading-relaxed">
                    {value || '-'}
                </code>
                <button
                    type="button"
                    onClick={onCopy}
                    disabled={copyDisabled}
                    className="p-2 text-gray-400 hover:text-white hover:bg-white/5 rounded-lg transition-colors shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
                    title="Salin Kredensial"
                >
                    {copied ? <Check className="w-4 h-4 text-green-400 animate-bounce" /> : <Copy className="w-4 h-4" />}
                </button>
            </div>
        </div>
    );
}

function PreferenceToggle({
    title,
    description,
    checked,
    onChange,
    withBorder = true
}: {
    title: string;
    description: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
    withBorder?: boolean;
}) {
    return (
        <div className={`flex flex-col sm:flex-row sm:items-center justify-between gap-4 py-4 transition-colors ${withBorder ? 'border-b ui-border' : ''}`}>
            <div className="space-y-0.5">
                <p className="text-sm font-semibold ui-text">{title}</p>
                <p className="text-xs ui-text-muted max-w-xl leading-relaxed">{description}</p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer shrink-0">
                <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => onChange(event.target.checked)}
                    className="sr-only peer"
                />
                <div className="w-11 h-6 bg-gray-600/30 rounded-full peer peer-focus:outline-none peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-orange-500" />
            </label>
        </div>
    );
}

function Endpoint({
    method,
    path,
    description,
    extra
}: {
    method: string;
    path: string;
    description: string;
    methodColor?: string;
    extra?: string;
}) {
    const isGet = method === 'GET';
    return (
        <div className="ui-panel-muted rounded-xl p-3.5 border ui-border space-y-2 text-xs hover:border-[color-mix(in_srgb,var(--ui-accent)_38%,transparent)] transition-all">
            <div className="flex items-center gap-2 flex-wrap">
                <span className={`px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-wider shrink-0 ${
                    isGet ? 'ui-success-chip' : 'ui-info-chip'
                }`}>
                    {method}
                </span>
                <code className="ui-text font-mono font-bold select-all break-all">{path}</code>
            </div>
            <p className="ui-text-muted leading-relaxed">{description}</p>
            {extra && (
                <div className="bg-black/10 rounded-lg p-2 border ui-border mt-2">
                    <code className="text-[10px] ui-accent-text font-mono leading-relaxed block break-all">{extra}</code>
                </div>
            )}
        </div>
    );
}
