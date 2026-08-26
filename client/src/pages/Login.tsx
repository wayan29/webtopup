import { useState, useEffect, useRef } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/useAuthStore';
import { Mail, Lock, Eye, EyeOff, ArrowRight, ShieldCheck } from 'lucide-react';
import DeviceLimitDialog, { type DeviceSession } from '../components/auth/DeviceLimitDialog';
import TurnstileField, { type TurnstileFieldHandle } from '../components/TurnstileField';
import { allowsRememberMe, audienceForRole, postLoginPath, readReturnTo, type LoginAudience } from '../auth/loginIntent';
import { apiV2 } from '../api';
import {
    isBotProtectionResponseError,
    shouldRenderTurnstile,
    turnstileSiteKey,
} from '../lib/botProtection';

type LoginProps = {
    /** Fixed by the route; never derived from user input. Enforcement stays server-side. */
    audience?: LoginAudience;
};

export default function Login({ audience = 'member' }: LoginProps) {
    const isStaff = audience === 'staff';
    const offersRememberMe = allowsRememberMe(audience);
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [otpCode, setOtpCode] = useState('');
    const [twoFactorChallenge, setTwoFactorChallenge] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [rememberMe, setRememberMe] = useState(false);
    const [deviceChallenge, setDeviceChallenge] = useState<{ challengeToken: string; sessions: DeviceSession[] } | null>(null);
    const [publicSettings, setPublicSettings] = useState<{ botProtectionEnabled?: unknown; turnstileSiteKey?: unknown }>({});
    const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
    const turnstileRef = useRef<TurnstileFieldHandle | null>(null);
    const login = useAuthStore((state) => state.login);
    const verifyTwoFactorLogin = useAuthStore((state) => state.verifyTwoFactorLogin);
    const completeDeviceSelection = useAuthStore((state) => state.completeDeviceSelection);
    const user = useAuthStore((state) => state.user);
    const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
    const navigate = useNavigate();
    const location = useLocation();
    // Read once per navigation; the value is re-sanitized against the session audience below.
    const requestedReturnTo = readReturnTo(audience, location.search);

    // Redirect if already authenticated
    useEffect(() => {
        if (isAuthenticated && user) {
            const sessionAudience: LoginAudience = audienceForRole(user.role);
            navigate(postLoginPath(sessionAudience, requestedReturnTo), { replace: true });
        }
    }, [isAuthenticated, user, navigate, requestedReturnTo]);

    useEffect(() => {
        let active = true;
        const fetchPublicSettings = async () => {
            try {
                const res = await apiV2.get('/settings/public');
                if (!active) return;
                setPublicSettings({
                    botProtectionEnabled: res.data?.botProtectionEnabled === true,
                    turnstileSiteKey: typeof res.data?.turnstileSiteKey === 'string' ? res.data.turnstileSiteKey : '',
                });
            } catch {
                if (!active) return;
                setPublicSettings({});
            }
        };
        fetchPublicSettings();
        return () => {
            active = false;
        };
    }, []);

    const showTurnstile = !twoFactorChallenge && shouldRenderTurnstile(publicSettings);
    const siteKey = turnstileSiteKey(publicSettings);
    const loginBlockedByTurnstile = showTurnstile && !turnstileToken;

    // Show loading if redirecting
    if (isAuthenticated && user) {
        return (
            <div className="ui-shell flex min-h-screen items-center justify-center ui-text">
                <div className="flex flex-col items-center space-y-4">
                    <div className="h-12 w-12 animate-spin rounded-full border-b-2 border-[var(--ui-accent)]"></div>
                    <p className="ui-text-muted">Redirecting...</p>
                </div>
            </div>
        );
    }

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        const normalizedEmail = email.trim().toLowerCase();

        if (!normalizedEmail || !password) {
            setError('Email dan password wajib diisi');
            return;
        }

        setLoading(true);
        try {
            const result = await login(
                audience,
                normalizedEmail,
                password,
                offersRememberMe && rememberMe,
                showTurnstile ? (turnstileToken ?? undefined) : undefined,
            );
            if (result && 'deviceLimit' in result) {
                setDeviceChallenge(result.deviceLimit);
            } else if (result?.requiresTwoFactor) {
                setTwoFactorChallenge(result.challengeToken);
                setOtpCode('');
            }
            // Redirect akan handled oleh useEffect
        } catch (err: any) {
            if (isBotProtectionResponseError(err)) {
                turnstileRef.current?.reset();
                setTurnstileToken(null);
            }
            // Handle axios error properly
            const message = err.response?.data?.message || 'Login failed. Please check your credentials.';
            setError(message);
        } finally {
            setLoading(false);
        }
    };

    const handleTwoFactorSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        const normalizedCode = otpCode.trim().replace(/\s+/g, '');

        if (!normalizedCode) {
            setError('Kode OTP wajib diisi');
            return;
        }

        setLoading(true);
        try {
            const result = await verifyTwoFactorLogin(audience, twoFactorChallenge, normalizedCode, offersRememberMe && rememberMe);
            if (result && 'deviceLimit' in result) setDeviceChallenge(result.deviceLimit);
        } catch (err: any) {
            const message = err.response?.data?.message || 'Kode OTP tidak valid.';
            setError(message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="ui-shell relative min-h-screen overflow-hidden ui-text">
            <div className="ui-accent-glow absolute -left-10 top-10 h-44 w-44 rounded-full blur-3xl" />
            <div className="ui-accent-glow absolute -right-16 bottom-10 h-56 w-56 rounded-full blur-3xl opacity-70" />

            <div className="relative mx-auto max-w-2xl py-16 px-6 lg:px-10">
                <div className="ui-card-gradient ui-border rounded-3xl border p-8 shadow-2xl backdrop-blur lg:p-10">
                    <div className="flex items-center justify-between mb-6">
                        <div>
                            <p className="ui-accent-text text-xs font-bold uppercase tracking-[0.2em]">{isStaff ? 'Internal Access' : 'Member Access'}</p>
                            <h2 className="ui-text mt-2 text-3xl font-black">Masuk akun</h2>
                            <p className="ui-text-muted mt-1 text-sm">
                                {isStaff
                                    ? 'Gunakan kredensial internal Anda untuk melanjutkan.'
                                    : 'Lanjutkan transaksi dan riwayat pembelian Anda.'}
                            </p>
                        </div>
                        {!isStaff && (
                        <div className="ui-text-muted hidden flex-col items-end text-right text-xs sm:flex">
                            <span className="ui-accent-chip rounded-full px-3 py-1 font-semibold">Promo hari ini</span>
                            <span className="mt-2">Gratis biaya admin</span>
                        </div>
                        )}
                    </div>

                    <form onSubmit={twoFactorChallenge ? handleTwoFactorSubmit : handleSubmit} className="space-y-5">
                        {error && (
                            <div className="bg-red-50 border border-red-200 text-red-700 p-4 rounded-xl flex items-start gap-2">
                                <XCircleIcon className="h-5 w-5 mt-0.5 text-red-500" />
                                <p className="text-sm leading-relaxed">{error}</p>
                            </div>
                        )}

                        {twoFactorChallenge ? (
                            <>
                                <div className="ui-panel-muted ui-border rounded-xl border p-4">
                                    <div className="flex items-start gap-3">
                                        <div className="ui-accent-chip rounded-xl p-2">
                                            <ShieldCheck className="h-5 w-5" />
                                        </div>
                                        <div>
                                            <p className="ui-text text-sm font-bold">Verifikasi 2FA</p>
                                            <p className="ui-text-muted mt-1 text-sm">Masukkan 6 digit kode dari aplikasi authenticator Anda.</p>
                                        </div>
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    <label htmlFor="otpCode" className="ui-text block text-sm font-semibold">
                                        Kode OTP
                                    </label>
                                    <input
                                        id="otpCode"
                                        name="otpCode"
                                        type="text"
                                        inputMode="numeric"
                                        autoComplete="one-time-code"
                                        required
                                        value={otpCode}
                                        onChange={(e) => setOtpCode(e.target.value)}
                                        className="ui-field block w-full rounded-xl px-4 py-3 text-center text-lg font-black tracking-[0.35em] transition-all"
                                        placeholder="000000"
                                        maxLength={8}
                                    />
                                </div>

                                <button
                                    type="submit"
                                    disabled={loading}
                                    className="ui-accent-solid flex w-full items-center justify-center rounded-xl px-4 py-3 text-sm font-bold shadow-lg transition-all duration-200 hover:brightness-105 focus:outline-none focus:ring-2 focus:ring-[var(--ui-ring)] disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                    {loading ? 'Memverifikasi...' : 'Verifikasi & masuk'}
                                </button>

                                <button
                                    type="button"
                                    disabled={loading}
                                    onClick={() => {
                                        setTwoFactorChallenge('');
                                        setOtpCode('');
                                        setError('');
                                    }}
                                    className="ui-muted-action w-full rounded-xl px-4 py-3 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                    Gunakan akun lain
                                </button>
                            </>
                        ) : (
                            <>
                        <div className="space-y-2">
                                <label htmlFor="email" className="ui-text block text-sm font-semibold">
                                Email
                            </label>
                            <div className="relative">
                                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                    <Mail className="ui-text-muted h-5 w-5" aria-hidden="true" />
                                </div>
                                <input
                                    id="email"
                                    name="email"
                                    type="email"
                                    autoComplete="email"
                                    required
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    autoCapitalize="none"
                                    className="ui-field block w-full rounded-xl py-3 pl-11 pr-3 text-sm font-medium transition-all"
                                    placeholder="user@example.com"
                                />
                            </div>
                        </div>

                            <div className="space-y-2">
                                <label htmlFor="password" className="ui-text block text-sm font-semibold">
                                    Password
                                </label>
                                <div className="relative">
                                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                        <Lock className="ui-text-muted h-5 w-5" aria-hidden="true" />
                                    </div>
                                    <input
                                        id="password"
                                        name="password"
                                        type={showPassword ? 'text' : 'password'}
                                        autoComplete="current-password"
                                        required
                                        value={password}
                                        onChange={(e) => setPassword(e.target.value)}
                                        className="ui-field block w-full rounded-xl py-3 pl-11 pr-11 text-sm font-medium transition-all"
                                        placeholder="••••••••"
                                    />
                                    <div className="absolute inset-y-0 right-0 pr-3 flex items-center">
                                        <button
                                            type="button"
                                            onClick={() => setShowPassword(!showPassword)}
                                            className="ui-text-muted hover:text-[var(--ui-text)] focus:outline-none"
                                        >
                                            {showPassword ? (
                                                <EyeOff className="h-5 w-5" aria-hidden="true" />
                                            ) : (
                                                <Eye className="h-5 w-5" aria-hidden="true" />
                                            )}
                                        </button>
                                    </div>
                                </div>
                            </div>

                            {offersRememberMe ? (
                            <label className="ui-panel-muted ui-border flex items-start gap-3 rounded-xl border px-4 py-3 text-sm">
                                <input type="checkbox" name="rememberMe" checked={rememberMe} onChange={(event) => setRememberMe(event.target.checked)} className="mt-1" />
                                <span><strong className="ui-text block">Ingat saya selama 30 hari di perangkat ini</strong><span className="ui-text-muted">Default tidak aktif.</span></span>
                            </label>
                            ) : (
                            <p className="ui-text-muted text-xs">Sesi internal berakhir setelah 8 jam dan tidak dapat diperpanjang.</p>
                            )}

                            {showTurnstile && siteKey ? (
                                <TurnstileField ref={turnstileRef} siteKey={siteKey} onTokenChange={setTurnstileToken} />
                            ) : null}

                            <button
                                type="submit"
                                disabled={loading || loginBlockedByTurnstile}
                                className="ui-accent-solid flex w-full items-center justify-center rounded-xl px-4 py-3 text-sm font-bold shadow-lg transition-all duration-200 hover:brightness-105 focus:outline-none focus:ring-2 focus:ring-[var(--ui-ring)] disabled:cursor-not-allowed disabled:opacity-60"
                            >
                                {loading ? 'Memproses...' : (
                                    <>
                                        Masuk sekarang <ArrowRight className="ml-2 h-4 w-4" />
                                    </>
                                )}
                            </button>

                            {!isStaff && (
                            <div className="ui-text-muted text-center text-sm">
                                Belum punya akun?{' '}
                                <Link to="/register" className="ui-accent-text font-semibold hover:brightness-110">
                                    Daftar Sekarang
                                </Link>
                            </div>
                            )}
                            </>
                        )}
                        </form>
                    </div>
                </div>
            {deviceChallenge && <DeviceLimitDialog sessions={deviceChallenge.sessions} busy={loading} onCancel={() => setDeviceChallenge(null)} onConfirm={async (sessionId) => { setLoading(true); setError(''); try { await completeDeviceSelection(audience, deviceChallenge.challengeToken, sessionId); setDeviceChallenge(null); } catch (err: any) { setError(err.response?.data?.message || 'Gagal mengganti perangkat'); } finally { setLoading(false); } }} />}
            </div>
    );
}

function XCircleIcon(props: any) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" {...props}>
            <path fillRule="evenodd" d="M12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25zm-1.72 6.97a.75.75 0 10-1.06 1.06L10.94 12l-1.72 1.72a.75.75 0 101.06 1.06L12 13.06l1.72 1.72a.75.75 0 101.06-1.06L13.06 12l1.72-1.72a.75.75 0 10-1.06-1.06L12 10.94l-1.72-1.72z" clipRule="evenodd" />
        </svg>
    )
}
