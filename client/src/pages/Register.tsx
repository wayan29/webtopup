import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/useAuthStore';
import { User, Mail, Lock, Eye, EyeOff, ArrowRight, AlertTriangle, Loader2, XCircle } from 'lucide-react';
import { apiV2 } from '../api';

interface PublicSettings {
    registrationEnabled: boolean;
    maintenanceMode: boolean;
    maintenanceMessage: string;
}

export default function Register() {
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [settingsLoading, setSettingsLoading] = useState(true);
    const [publicSettings, setPublicSettings] = useState<PublicSettings>({
        registrationEnabled: true,
        maintenanceMode: false,
        maintenanceMessage: ''
    });
    const register = useAuthStore((state) => state.register);
    const user = useAuthStore((state) => state.user);
    const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
    const navigate = useNavigate();

    useEffect(() => {
        if (isAuthenticated && user) {
            if (['owner', 'admin', 'cs'].includes(user.role)) {
                navigate('/admin/dashboard', { replace: true });
            } else {
                navigate('/dashboard', { replace: true });
            }
        }
    }, [isAuthenticated, user, navigate]);

    useEffect(() => {
        const fetchPublicSettings = async () => {
            try {
                const res = await apiV2.get('/settings/public');
                setPublicSettings({
                    registrationEnabled: res.data?.registrationEnabled !== false,
                    maintenanceMode: res.data?.maintenanceMode === true,
                    maintenanceMessage: res.data?.maintenanceMessage || ''
                });
            } catch (err) {
                console.error('Failed to load public settings', err);
            } finally {
                setSettingsLoading(false);
            }
        };

        fetchPublicSettings();
    }, []);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        const normalizedName = name.trim();
        const normalizedEmail = email.trim().toLowerCase();

        if (password !== confirmPassword) {
            setError('Password dan konfirmasi password harus sama');
            return;
        }

        if (normalizedName.length < 2) {
            setError('Nama minimal 2 karakter');
            return;
        }

        if (password.length < 12) {
            setError('Password minimal 12 karakter');
            return;
        }

        setLoading(true);
        try {
            await register(normalizedName, normalizedEmail, password);
            navigate('/dashboard');
        } catch (err: any) {
            const message = err.response?.data?.message || 'Registration failed. Please try again.';
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
                            <p className="ui-accent-text text-xs font-bold uppercase tracking-[0.2em]">New Member</p>
                            <h2 className="ui-text mt-2 text-3xl font-black">Buat akun baru</h2>
                            <p className="ui-text-muted mt-1 text-sm">Semua keuntungan langsung aktif setelah verifikasi.</p>
                        </div>
                        <div className="ui-text-muted hidden flex-col items-end text-right text-xs sm:flex">
                            <span className="ui-accent-chip rounded-full px-3 py-1 font-semibold">Bonus awal</span>
                            <span className="mt-2">Cashback pertama kali</span>
                        </div>
                    </div>

                    {settingsLoading ? (
                        <div className="ui-text-muted flex items-center justify-center py-16">
                            <Loader2 className="h-6 w-6 animate-spin" />
                        </div>
                    ) : publicSettings.maintenanceMode || !publicSettings.registrationEnabled ? (
                        <div className="ui-warning-chip rounded-2xl border p-6">
                            <div className="flex items-start gap-3">
                                <AlertTriangle className="mt-0.5 h-5 w-5 text-amber-600" />
                                <div className="space-y-3">
                                    <h3 className="text-lg font-bold">
                                        {publicSettings.maintenanceMode ? 'Registrasi ditutup sementara' : 'Registrasi sedang dinonaktifkan'}
                                    </h3>
                                    <p className="text-sm leading-relaxed">
                                        {publicSettings.maintenanceMode
                                            ? (publicSettings.maintenanceMessage || 'Sistem sedang dalam pemeliharaan. Silakan coba beberapa saat lagi.')
                                            : 'Pendaftaran member baru sedang dinonaktifkan oleh admin.'}
                                    </p>
                                    <div className="flex flex-wrap gap-3">
                                        <Link to="/" className="ui-muted-action rounded-xl px-4 py-2 text-sm font-semibold">
                                            Kembali ke Home
                                        </Link>
                                        <Link to="/login" className="ui-accent-solid rounded-xl px-4 py-2 text-sm font-semibold hover:brightness-105">
                                            Login
                                        </Link>
                                    </div>
                                </div>
                            </div>
                        </div>
                    ) : (
                    <form onSubmit={handleSubmit} className="space-y-5">
                        {error && (
                            <div className="bg-red-50 border border-red-200 text-red-700 p-4 rounded-xl flex items-start gap-2">
                                <XCircle className="h-5 w-5 mt-0.5 text-red-500" />
                                <p className="text-sm leading-relaxed">{error}</p>
                            </div>
                        )}

                        <div className="space-y-2">
                            <label htmlFor="name" className="ui-text block text-sm font-semibold">
                                Nama lengkap
                            </label>
                            <div className="relative">
                                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                    <User className="ui-text-muted h-5 w-5" aria-hidden="true" />
                                </div>
                                <input
                                    id="name"
                                    name="name"
                                    type="text"
                                    autoComplete="name"
                                    required
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    className="ui-field block w-full rounded-xl py-3 pl-11 pr-3 text-sm font-medium transition-all"
                                    placeholder="Nama sesuai KTP"
                                />
                            </div>
                        </div>

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
                                        autoComplete="new-password"
                                        required
                                        value={password}
                                        onChange={(e) => setPassword(e.target.value)}
                                        className="ui-field block w-full rounded-xl py-3 pl-11 pr-11 text-sm font-medium transition-all"
                                        placeholder="Minimal 12 karakter"
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

                            <div className="space-y-2">
                                <label htmlFor="confirmPassword" className="ui-text block text-sm font-semibold">
                                    Konfirmasi password
                                </label>
                                <div className="relative">
                                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                        <Lock className="ui-text-muted h-5 w-5" aria-hidden="true" />
                                    </div>
                                    <input
                                        id="confirmPassword"
                                        name="confirmPassword"
                                        type={showPassword ? 'text' : 'password'}
                                        autoComplete="new-password"
                                        required
                                        value={confirmPassword}
                                        onChange={(e) => setConfirmPassword(e.target.value)}
                                        className="ui-field block w-full rounded-xl py-3 pl-11 pr-11 text-sm font-medium transition-all"
                                        placeholder="Ulangi password"
                                    />
                                </div>
                            </div>

                            <button
                                type="submit"
                                disabled={loading}
                                className="ui-accent-solid flex w-full items-center justify-center rounded-xl px-4 py-3 text-sm font-bold shadow-lg transition-all duration-200 hover:brightness-105 focus:outline-none focus:ring-2 focus:ring-[var(--ui-ring)] disabled:cursor-not-allowed disabled:opacity-60"
                            >
                                {loading ? 'Membuat akun...' : (
                                    <>
                                        Daftar sekarang <ArrowRight className="ml-2 h-4 w-4" />
                                    </>
                                )}
                            </button>

                            <div className="ui-text-muted text-center text-sm">
                                Sudah punya akun?{' '}
                                <Link to="/login" className="ui-accent-text font-semibold hover:brightness-110">
                                    Masuk Sekarang
                                </Link>
                            </div>
                    </form>
                    )}
                </div>
            </div>
        </div>
    );
}
