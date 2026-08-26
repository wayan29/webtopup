import { Link, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../store/useAuthStore';
import { LogOut, MoreHorizontal, Moon, Sun, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { apiV2 } from '../api';
import { PublicBottomNav } from '../components/public/PublicBottomNav';
import { getAssetUrl } from '../lib/assetUrl';
import { DEFAULT_PUBLIC_BRANDING, applyPublicBrandingMetadata, safeBrandAssetUrl } from '../lib/publicBranding';
import { DARK_UI_THEME, DEFAULT_UI_THEME, GUEST_UI_THEME_STORAGE_KEY, LIGHT_UI_THEME, UI_THEME_OPTIONS, getUIThemeMeta, isUIThemeId, type UIThemeId } from '../lib/uiTheme';

interface PublicSettings {
    brand: string;
    title: string;
    favicon: string;
    logo: string;
    description: string;
    footerText: string;
    registrationEnabled: boolean;
    maintenanceMode: boolean;
    maintenanceMessage: string;
    popupBannerEnabled: boolean;
    popupBannerImage: string;
    popupBannerTitle: string;
    popupBannerDescription: string;
    popupBannerLink: string;
    botProtectionEnabled: boolean;
    turnstileSiteKey: string;
}

const defaultPublicSettings: PublicSettings = {
    ...DEFAULT_PUBLIC_BRANDING,
    registrationEnabled: true,
    maintenanceMode: false,
    maintenanceMessage: '',
    popupBannerEnabled: false,
    popupBannerImage: '',
    popupBannerTitle: '',
    popupBannerDescription: '',
    popupBannerLink: '',
    botProtectionEnabled: false,
    turnstileSiteKey: ''
};

export default function MainLayout() {
    const { isAuthenticated, logout } = useAuthStore();
    const navigate = useNavigate();
    const location = useLocation();
    // Secondary mobile sheet for deposit/voucher/register/theme — primary destinations use bottom nav.
    const [isMoreOpen, setIsMoreOpen] = useState(false);
    const [publicSettings, setPublicSettings] = useState<PublicSettings>(defaultPublicSettings);
    const [showPopupBanner, setShowPopupBanner] = useState(false);
    const [guestTheme, setGuestTheme] = useState<UIThemeId>(() => {
        const storedTheme = localStorage.getItem(GUEST_UI_THEME_STORAGE_KEY);
        return isUIThemeId(storedTheme) ? storedTheme : DEFAULT_UI_THEME;
    });

    useEffect(() => {
        let active = true;
        const applySettings = (settings: PublicSettings) => {
            if (!active) return;
            setPublicSettings(settings);
            applyPublicBrandingMetadata(settings, document);
        };
        const fetchPublicSettings = async () => {
            try {
                const res = await apiV2.get('/settings/public');
                const receivedSettings = { ...defaultPublicSettings, ...res.data };
                const nextSettings = {
                    ...receivedSettings,
                    favicon: safeBrandAssetUrl(receivedSettings.favicon, DEFAULT_PUBLIC_BRANDING.favicon, window.location.origin),
                    logo: safeBrandAssetUrl(receivedSettings.logo, DEFAULT_PUBLIC_BRANDING.logo, window.location.origin)
                };
                applySettings(nextSettings);

                const popupKey = [
                    nextSettings.popupBannerImage,
                    nextSettings.popupBannerTitle,
                    nextSettings.popupBannerLink
                ].join('|');

                if (
                    nextSettings.popupBannerEnabled
                    && (nextSettings.popupBannerImage || nextSettings.popupBannerTitle || nextSettings.popupBannerDescription)
                    && sessionStorage.getItem('sitePopupDismissed') !== popupKey
                ) {
                    setShowPopupBanner(true);
                }
            } catch (error) {
                console.error('Failed to load public settings', error);
                applySettings(defaultPublicSettings);
            }
        };

        applyPublicBrandingMetadata(defaultPublicSettings, document);
        fetchPublicSettings();
        return () => {
            active = false;
        };
    }, []);

    const handleLogout = () => {
        logout();
        navigate('/login');
    };

    const handleInternalNavigate = (path: string) => {
        setIsMoreOpen(false);
        navigate(path);
    };

    useEffect(() => {
        setIsMoreOpen(false);
    }, [location.pathname]);

    const handleGuestThemeChange = (themeId: UIThemeId) => {
        localStorage.setItem(GUEST_UI_THEME_STORAGE_KEY, themeId);
        setGuestTheme(themeId);
        window.dispatchEvent(new Event('guest-ui-theme-change'));
    };

    const getMediaUrl = (path: string) => {
        if (!path) return '';
        if (/^https?:\/\//i.test(path)) return path;
        return getAssetUrl(path);
    };

    const getSafeLink = (link: string) => {
        const normalized = link.trim();

        if (!normalized) {
            return null;
        }

        if (normalized.startsWith('/')) {
            return normalized.startsWith('//') ? null : normalized;
        }

        try {
            const parsed = new URL(normalized);
            return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : null;
        } catch {
            return null;
        }
    };

    const popupLink = getSafeLink(publicSettings.popupBannerLink);
    const popupKey = [
        publicSettings.popupBannerImage,
        publicSettings.popupBannerTitle,
        publicSettings.popupBannerLink
    ].join('|');

    const closePopupBanner = () => {
        sessionStorage.setItem('sitePopupDismissed', popupKey);
        setShowPopupBanner(false);
    };

    const isDashboardPage = location.pathname === '/dashboard' || 
                            location.pathname === '/deposit' ||
                            location.pathname === '/redeem-voucher' ||
                            location.pathname === '/credits' ||
                            location.pathname === '/transactions' ||
                            location.pathname === '/mutations' ||
                            location.pathname === '/reports' ||
                            location.pathname === '/settings';

    const isOrderPage = location.pathname === '/order' || location.pathname.startsWith('/order/');

    // Order page - full screen tanpa navbar/footer
    if (isOrderPage) {
        return <Outlet />;
    }

    if (isAuthenticated && isDashboardPage) {
        return <Outlet />;
    }

    // Default layout for non-dashboard pages
    return (
        <div className="ui-shell min-h-screen ui-text selection:bg-[var(--ui-accent-soft)]">
            <div className="fixed inset-0 pointer-events-none overflow-hidden">
                <div className="ui-accent-glow absolute -top-24 left-1/3 h-72 w-72 rounded-full blur-[110px]" />
                <div className="ui-accent-glow absolute bottom-0 right-1/4 h-80 w-80 rounded-full blur-[120px] opacity-70" />
            </div>

            <div className="relative flex min-h-screen flex-col">
                <nav className="sticky top-0 z-40 border-b ui-border bg-[color-mix(in_srgb,var(--ui-body-bg)_86%,transparent)] backdrop-blur-xl max-sm:backdrop-blur-md">
                    <div className="mx-auto flex h-20 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
                        <div className="flex min-w-0 items-center gap-6 lg:gap-10">
                            <Link to="/" className="group flex min-w-0 items-center gap-3">
                                <img
                                    src={publicSettings.logo}
                                    alt={`${publicSettings.brand} logo`}
                                    className="h-11 w-auto max-w-40 shrink-0 transition-transform group-hover:scale-105"
                                />
                                <div className="min-w-0">
                                    <p className="ui-text-muted text-[11px] font-semibold uppercase tracking-[0.34em]">Portal Publik</p>
                                    <p className="truncate text-lg font-black ui-text">{publicSettings.brand}</p>
                                </div>
                            </Link>
                            <div className="hidden items-center gap-2 rounded-2xl border ui-border bg-[var(--ui-card-bg)]/75 p-1 sm:flex">
                                <Link
                                    to="/"
                                    className={`rounded-xl border px-4 py-2 text-sm font-semibold transition-colors ${location.pathname === '/'
                                        ? 'ui-accent-chip'
                                        : 'border-transparent ui-text-muted hover:border-[var(--ui-border)] hover:bg-[var(--ui-card-muted)] hover:text-[var(--ui-text)]'
                                    }`}
                                >
                                    Beranda
                                </Link>
                                <Link
                                    to="/products"
                                    className={`rounded-xl border px-4 py-2 text-sm font-semibold transition-colors ${location.pathname.startsWith('/products')
                                        ? 'ui-accent-chip'
                                        : 'border-transparent ui-text-muted hover:border-[var(--ui-border)] hover:bg-[var(--ui-card-muted)] hover:text-[var(--ui-text)]'
                                    }`}
                                >
                                    Produk
                                </Link>
                            </div>
                        </div>

                        <div className="hidden items-center gap-3 sm:flex">
                            {!isAuthenticated && (
                                <GuestThemeSwitcher value={guestTheme} onChange={handleGuestThemeChange} />
                            )}
                            {isAuthenticated ? (
                                <>
                                    <Link
                                        to="/dashboard"
                                        className="ui-muted-action rounded-full px-4 py-2 text-sm font-semibold"
                                    >
                                        Dashboard
                                    </Link>
                                    <button
                                        type="button"
                                        onClick={() => handleInternalNavigate('/dashboard/deposit')}
                                        className="ui-muted-action rounded-full px-4 py-2 text-sm font-semibold"
                                    >
                                        Deposit
                                    </button>
                                    <Link
                                        to="/redeem-voucher"
                                        className="ui-muted-action rounded-full px-4 py-2 text-sm font-semibold"
                                    >
                                        Voucher
                                    </Link>
                                    <button
                                        onClick={handleLogout}
                                        className="ui-danger-action flex h-11 w-11 items-center justify-center rounded-full border transition"
                                    >
                                        <LogOut className="h-5 w-5" />
                                    </button>
                                </>
                            ) : (
                                <>
                                    <Link
                                        to="/login"
                                        className="ui-muted-action rounded-full px-4 py-2 text-sm font-semibold"
                                    >
                                        Masuk
                                    </Link>
                                    {publicSettings.registrationEnabled && (
                                        <Link
                                            to="/register"
                                            className="ui-accent-solid rounded-full px-5 py-2.5 text-sm font-semibold shadow-lg transition hover:brightness-105"
                                        >
                                            Daftar
                                        </Link>
                                    )}
                                </>
                            )}
                        </div>

                        <div className="flex items-center sm:hidden">
                            <button
                                type="button"
                                aria-label={isMoreOpen ? 'Tutup menu tambahan' : 'Buka menu tambahan'}
                                aria-expanded={isMoreOpen}
                                onClick={() => setIsMoreOpen((open) => !open)}
                                className="ui-muted-action inline-flex h-11 w-11 items-center justify-center rounded-2xl p-0"
                            >
                                {isMoreOpen ? <X className="h-5 w-5" /> : <MoreHorizontal className="h-5 w-5" />}
                            </button>
                        </div>
                    </div>

                    {isMoreOpen && (
                        <div className="border-t ui-border bg-[var(--ui-panel-bg)]/95 backdrop-blur-xl sm:hidden">
                            <div className="space-y-2 px-4 py-4">
                                <div className="mb-3 rounded-2xl border ui-border bg-[var(--ui-card-bg)]/80 p-4">
                                    <p className="text-[11px] font-semibold uppercase tracking-[0.24em] ui-accent-text">Lainnya</p>
                                    <p className="mt-1 text-sm ui-text-muted">Aksi sekunder. Navigasi utama ada di bilah bawah.</p>
                                </div>
                                {isAuthenticated ? (
                                    <>
                                        <button
                                            type="button"
                                            onClick={() => handleInternalNavigate('/dashboard/deposit')}
                                            className="ui-muted-action block w-full rounded-2xl px-4 py-3 text-left text-sm font-semibold"
                                        >
                                            Deposit
                                        </button>
                                        <Link
                                            to="/redeem-voucher"
                                            onClick={() => setIsMoreOpen(false)}
                                            className="ui-muted-action block rounded-2xl px-4 py-3 text-sm font-semibold"
                                        >
                                            Voucher
                                        </Link>
                                        <button
                                            onClick={handleLogout}
                                            className="ui-danger-action block w-full rounded-2xl border px-4 py-3 text-left text-sm font-semibold"
                                        >
                                            Logout
                                        </button>
                                    </>
                                ) : (
                                    <>
                                        <GuestThemeSwitcher value={guestTheme} onChange={handleGuestThemeChange} compact />
                                        {publicSettings.registrationEnabled && (
                                            <Link
                                                to="/register"
                                                onClick={() => setIsMoreOpen(false)}
                                                className="ui-accent-solid block rounded-2xl px-4 py-3 text-sm font-semibold"
                                            >
                                                Daftar
                                            </Link>
                                        )}
                                    </>
                                )}
                            </div>
                        </div>
                    )}
                </nav>

                {publicSettings.maintenanceMode && (
                    <div className="border-b ui-border bg-[var(--ui-warning-soft)]">
                        <div className="mx-auto max-w-7xl px-4 py-3 text-sm ui-warning-text sm:px-6 lg:px-8">
                            {publicSettings.maintenanceMessage || 'Sistem sedang dalam pemeliharaan. Silakan coba beberapa saat lagi.'}
                        </div>
                    </div>
                )}

                <main className="flex-grow pb-[calc(4.75rem+env(safe-area-inset-bottom,0px))] sm:pb-0">
                    <div className="mx-auto max-w-7xl py-6 sm:px-6 lg:px-8">
                        <Outlet />
                    </div>
                </main>

                <PublicBottomNav pathname={location.pathname} isAuthenticated={isAuthenticated} />

                <footer className="ui-panel ui-border hidden border-t sm:block">
                    <div className="ui-subtle-grid mx-auto flex max-w-7xl flex-col gap-4 px-4 py-8 sm:px-6 lg:px-8 lg:flex-row lg:items-center lg:justify-between">
                        <div>
                            <p className="ui-text-muted text-[11px] font-semibold uppercase tracking-[0.34em]">Portal Publik</p>
                            <p className="ui-text-muted mt-2 text-sm">{publicSettings.footerText}</p>
                        </div>
                        <div className="ui-text-muted flex flex-wrap gap-2 text-sm">
                            <Link to="/products" className="ui-panel-muted ui-border rounded-full border px-3 py-2 transition hover:text-[var(--ui-text)]">Produk</Link>
                            <Link to="/check-transaction" className="ui-panel-muted ui-border rounded-full border px-3 py-2 transition hover:text-[var(--ui-text)]">Cek transaksi</Link>
                            <Link to="/articles" className="ui-panel-muted ui-border rounded-full border px-3 py-2 transition hover:text-[var(--ui-text)]">Artikel</Link>
                            <span className="ui-panel-muted ui-border rounded-full border px-3 py-2">QRIS & e-wallet</span>
                            <span className="ui-panel-muted ui-border rounded-full border px-3 py-2">Support WhatsApp</span>
                        </div>
                    </div>
                </footer>

                {showPopupBanner && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="public-popup-title">
                        <div className="ui-panel ui-border relative w-full max-w-xl overflow-hidden rounded-[32px] border shadow-2xl">
                            <button
                                type="button"
                                aria-label="Tutup banner promo"
                                onClick={closePopupBanner}
                                className="ui-muted-action absolute right-4 top-4 z-10 rounded-full p-2"
                            >
                                <X className="h-4 w-4" />
                            </button>
                            {publicSettings.popupBannerImage && (
                                <img
                                    src={getMediaUrl(publicSettings.popupBannerImage)}
                                    alt={publicSettings.popupBannerTitle || 'Popup banner'}
                                    loading="lazy"
                                    className="h-56 w-full object-cover"
                                />
                            )}
                            <div className="space-y-3 p-6 ui-text">
                                {publicSettings.popupBannerTitle && (
                                    <h2 id="public-popup-title" className="ui-text text-2xl font-black">{publicSettings.popupBannerTitle}</h2>
                                )}
                                {publicSettings.popupBannerDescription && (
                                    <p className="ui-text-muted text-sm leading-relaxed">{publicSettings.popupBannerDescription}</p>
                                )}
                                <div className="flex flex-wrap gap-3 pt-2">
                                    <button
                                        type="button"
                                        onClick={closePopupBanner}
                                        className="ui-muted-action rounded-xl px-4 py-2 text-sm font-semibold"
                                    >
                                        Tutup
                                    </button>
                                    {popupLink && (
                                        <a
                                            href={popupLink}
                                            target={/^https?:\/\//i.test(popupLink) ? '_blank' : undefined}
                                            rel={/^https?:\/\//i.test(popupLink) ? 'noreferrer' : undefined}
                                            className="ui-accent-solid rounded-xl px-4 py-2 text-sm font-semibold transition hover:brightness-105"
                                        >
                                            Lihat Detail
                                        </a>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

function GuestThemeSwitcher({
    value,
    onChange,
    compact = false
}: {
    value: UIThemeId;
    onChange: (themeId: UIThemeId) => void;
    compact?: boolean;
}) {
    const activeTheme = getUIThemeMeta(value);

    return (
        <div className={compact ? 'space-y-2' : 'flex items-center gap-2 rounded-full border border-[var(--ui-border)] bg-[var(--ui-panel-bg)] px-3 py-2'}>
            <span className={compact ? 'block text-xs font-semibold uppercase tracking-[0.22em] text-[var(--ui-text-muted)]' : 'text-xs font-semibold text-[var(--ui-text-muted)]'}>
                UI Theme
            </span>
            <div className={compact ? 'grid grid-cols-2 gap-2' : 'flex items-center gap-1'}>
                <button
                    type="button"
                    onClick={() => onChange(DARK_UI_THEME)}
                    className={`inline-flex items-center justify-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                        value === DARK_UI_THEME
                            ? 'ui-accent-chip'
                            : 'border-[var(--ui-border)] bg-[var(--ui-panel-muted)] text-[var(--ui-text-muted)] hover:text-[var(--ui-text)]'
                    }`}
                >
                    <Moon className="h-3.5 w-3.5" />
                    Malam
                </button>
                <button
                    type="button"
                    onClick={() => onChange(LIGHT_UI_THEME)}
                    className={`inline-flex items-center justify-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                        value === LIGHT_UI_THEME
                            ? 'ui-accent-chip'
                            : 'border-[var(--ui-border)] bg-[var(--ui-panel-muted)] text-[var(--ui-text-muted)] hover:text-[var(--ui-text)]'
                    }`}
                >
                    <Sun className="h-3.5 w-3.5" />
                    Terang
                </button>
            </div>
            <select
                value={value}
                onChange={(event) => onChange(event.target.value as UIThemeId)}
                className={compact
                    ? 'w-full rounded-2xl border border-[var(--ui-border)] bg-[var(--ui-panel-bg)] px-4 py-3 text-sm font-semibold text-[var(--ui-text)] outline-none'
                    : 'max-w-[170px] rounded-full border border-[var(--ui-border)] bg-[var(--ui-panel-muted)] px-3 py-1.5 text-sm font-semibold text-[var(--ui-text)] outline-none'}
                title={activeTheme.description}
            >
                {UI_THEME_OPTIONS.map((theme) => (
                    <option key={theme.id} value={theme.id}>{theme.label}</option>
                ))}
            </select>
        </div>
    );
}
