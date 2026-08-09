import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Eye, EyeOff, KeyRound, Loader2, LogOut, QrCode, RefreshCw, ShieldCheck, ShieldX } from 'lucide-react';
import QRCode from 'qrcode';
import { apiV2 } from '../../api';
import { useStepUpOrchestration } from '../../auth/useStepUpOrchestration';
import { stepUpActionErrorMessage } from '../../auth/withStepUp';
import { useAuthStore } from '../../store/useAuthStore';

type TwoFactorSetup = {
    secret: string;
    /** Data-URL for the otpauth QR. Generated client-side when API returns null. */
    qrCodeDataUrl: string;
};

async function resolveSetupPayload(data: {
    secret?: string;
    otpauthUrl?: string;
    qrCodeDataUrl?: string | null;
}): Promise<TwoFactorSetup> {
    const secret = typeof data.secret === 'string' ? data.secret.trim() : '';
    if (!secret) {
        throw new Error('Setup 2FA tidak mengembalikan secret');
    }
    let qrCodeDataUrl =
        typeof data.qrCodeDataUrl === 'string' && data.qrCodeDataUrl.startsWith('data:')
            ? data.qrCodeDataUrl
            : '';
    if (!qrCodeDataUrl) {
        const otpauthUrl =
            typeof data.otpauthUrl === 'string' && data.otpauthUrl.startsWith('otpauth://')
                ? data.otpauthUrl
                : `otpauth://totp/PPOB%20Admin?secret=${encodeURIComponent(secret)}&issuer=PPOB%20Admin`;
        qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl, {
            errorCorrectionLevel: 'M',
            margin: 1,
            width: 220,
            color: { dark: '#0f172a', light: '#ffffff' },
        });
    }
    return { secret, qrCodeDataUrl };
}

const normalizeOtpInput = (value: string) => value.replace(/\D/g, '').slice(0, 6);

export default function Security() {
    const stepUp = useStepUpOrchestration();
    const syncProfile = useAuthStore((state) => state.syncProfile);
    const logout = useAuthStore((state) => state.logout);
    const enrollmentRequiredAt = useAuthStore((state) => state.user?.twoFactorEnrollmentRequiredAt);
    const [enabled, setEnabled] = useState(false);
    const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
    const [code, setCode] = useState('');
    const [disableCode, setDisableCode] = useState('');
    const [disablePassword, setDisablePassword] = useState('');
    const [showDisablePassword, setShowDisablePassword] = useState(false);
    const [showManualSecret, setShowManualSecret] = useState(false);
    const [confirmRevokeOpen, setConfirmRevokeOpen] = useState(false);
    const [message, setMessage] = useState('');
    const [error, setError] = useState('');
    const [statusLoaded, setStatusLoaded] = useState(false);
    const [loading, setLoading] = useState(true);
    const [actionLoading, setActionLoading] = useState(false);

    const loadStatus = async () => {
        setLoading(true);
        setStatusLoaded(false);
        setError('');
        try {
            const res = await apiV2.get('/auth/2fa/status');
            setEnabled(res.data.enabled === true);
            setStatusLoaded(true);
            // Copying the secret backgrounds the tab, and Android may discard it. The server keeps
            // the pending secret alive for its TTL, so resume the code form instead of making the
            // user restart setup, which would invalidate the entry already in their authenticator.
            if (res.data.enabled !== true && res.data.setupPending === true) {
                const resumed = await apiV2.post('/auth/2fa/setup');
                setSetup(await resolveSetupPayload(resumed.data));
            }
        } catch (err: any) {
            setError(err.response?.data?.message || 'Gagal memuat status 2FA');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadStatus();
    }, []);

    useEffect(() => {
        const handler = () => loadStatus();
        window.addEventListener('admin:refresh-current-page', handler);
        return () => window.removeEventListener('admin:refresh-current-page', handler);
    }, []);

    const startSetup = async () => {
        setActionLoading(true);
        setError('');
        setMessage('');
        setShowManualSecret(false);
        try {
            const res = await apiV2.post('/auth/2fa/setup');
            setSetup(await resolveSetupPayload(res.data));
        } catch (err: any) {
            setError(err.response?.data?.message || 'Gagal memulai setup 2FA');
        } finally {
            setActionLoading(false);
        }
    };

    const confirmSetup = async (event: React.FormEvent) => {
        event.preventDefault();
        setActionLoading(true);
        setError('');
        setMessage('');
        try {
            const res = await apiV2.post('/auth/2fa/confirm', { code });
            setEnabled(res.data.enabled === true);
            setSetup(null);
            setCode('');
            setDisableCode('');
            setShowManualSecret(false);
            if (res.data.requiresRelogin) {
                setMessage(res.data.message || '2FA berhasil diaktifkan. Silakan login ulang.');
                logout();
                return;
            }
            setMessage(res.data.message || '2FA berhasil diaktifkan');
            await syncProfile();
        } catch (err: any) {
            setError(err.response?.data?.message || 'Kode OTP tidak valid');
        } finally {
            setActionLoading(false);
        }
    };

    const disableTwoFactor = async (event: React.FormEvent) => {
        event.preventDefault();
        setActionLoading(true);
        setError('');
        setMessage('');
        try {
            const res = await apiV2.post('/auth/2fa/disable', { code: disableCode, password: disablePassword });
            setEnabled(res.data.enabled === true);
            setDisableCode('');
            setDisablePassword('');
            setSetup(null);
            setShowManualSecret(false);
            setMessage(res.data.message || '2FA berhasil dinonaktifkan');
            await syncProfile();
        } catch (err: any) {
            setError(err.response?.data?.message || 'Gagal menonaktifkan 2FA');
        } finally {
            setActionLoading(false);
        }
    };

    const revokeSessions = async () => {
        setActionLoading(true);
        setError('');
        setMessage('');
        try {
            await stepUp.run(
                'security.sessions_all',
                (config) => apiV2.post('/auth/sessions/revoke-all', {}, { ...config, _skipAuthRefresh: true } as never),
            );
            logout();
        } catch (err: any) {
            const text = stepUpActionErrorMessage(err, 'Gagal mencabut sesi aktif');
            if (text) setError(text);
            setActionLoading(false);
            setConfirmRevokeOpen(false);
        }
    };

    return (<>

        <div className="space-y-6">
            {enrollmentRequiredAt && !enabled ? (
                <div role="status" aria-live="polite" className="ui-warning-chip rounded-2xl px-4 py-3 text-sm font-bold">
                    2FA wajib untuk akun staf. Selesaikan aktivasi untuk membuka kembali seluruh menu admin.
                </div>
            ) : null}
            {error && <div className="ui-danger-chip rounded-2xl px-4 py-3 text-sm font-bold">{error}</div>}
            {message && <div className="ui-success-chip rounded-2xl px-4 py-3 text-sm font-bold">{message}</div>}

            <div className="ui-panel ui-border rounded-3xl border p-6 shadow-lg">
                <div className={`mb-5 w-fit rounded-2xl px-4 py-3 text-sm font-bold ${enabled ? 'ui-success-chip' : 'ui-warning-chip'}`}>
                    {enabled ? '2FA aktif' : '2FA belum aktif'}
                </div>
                {loading ? (
                    <div className="flex items-center gap-3 ui-text-muted">
                        <Loader2 className="h-5 w-5 animate-spin" />
                        Memuat status keamanan...
                    </div>
                ) : !statusLoaded ? (
                    <div className="space-y-4">
                        <h2 className="ui-text text-lg font-black">Status keamanan tidak dapat dimuat</h2>
                        <p className="ui-text-muted text-sm">Periksa koneksi atau izin akun, lalu coba muat ulang halaman ini.</p>
                        <button type="button" onClick={loadStatus} className="ui-muted-action inline-flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-bold">
                            <RefreshCw className="h-4 w-4" /> Segarkan
                        </button>
                    </div>
                ) : enabled ? (
                    <form onSubmit={disableTwoFactor} className="space-y-5">
                        <div className="flex items-start gap-4">
                            <div className="ui-success-chip rounded-2xl p-3"><ShieldCheck className="h-6 w-6" /></div>
                            <div>
                                <h2 className="ui-text text-lg font-black">2FA aktif di akun ini</h2>
                                <p className="ui-text-muted mt-1 text-sm">Masukkan kode OTP 6 digit dan password akun untuk menonaktifkan 2FA.</p>
                            </div>
                        </div>
                        <div>
                            <label htmlFor="disableTwoFactorCode" className="ui-text block text-sm font-bold">Kode OTP saat ini</label>
                            <input
                                id="disableTwoFactorCode"
                                value={disableCode}
                                onChange={(event) => setDisableCode(normalizeOtpInput(event.target.value))}
                                className="ui-field mt-2 block w-full max-w-sm rounded-xl px-4 py-3 text-center text-lg font-black tracking-[0.35em]"
                                placeholder="000000"
                                inputMode="numeric"
                                autoComplete="one-time-code"
                                maxLength={6}
                                pattern="[0-9]{6}"
                                required
                            />
                        </div>
                        <div>
                            <label htmlFor="disableTwoFactorPassword" className="ui-text block text-sm font-bold">Password akun</label>
                            <div className="relative mt-2 max-w-sm">
                                <input
                                    id="disableTwoFactorPassword"
                                    type={showDisablePassword ? 'text' : 'password'}
                                    value={disablePassword}
                                    onChange={(event) => setDisablePassword(event.target.value)}
                                    className="ui-field block w-full rounded-xl px-4 py-3 pr-12 text-sm font-bold"
                                    placeholder="Masukkan password akun"
                                    autoComplete="current-password"
                                    required
                                />
                                <button
                                    type="button"
                                    onClick={() => setShowDisablePassword((value) => !value)}
                                    className="ui-text-muted absolute right-3 top-1/2 -translate-y-1/2"
                                    aria-label={showDisablePassword ? 'Sembunyikan password' : 'Tampilkan password'}
                                >
                                    {showDisablePassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                </button>
                            </div>
                        </div>
                        <button type="submit" disabled={actionLoading || disableCode.length !== 6 || !disablePassword.trim()} className="ui-danger-action inline-flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-60">
                            <ShieldX className="h-4 w-4" /> {actionLoading ? 'Memproses...' : 'Nonaktifkan 2FA'}
                        </button>
                    </form>
                ) : setup ? (
                    <form onSubmit={confirmSetup} className="space-y-6">
                        <div className="flex items-start gap-4">
                            <div className="ui-accent-chip rounded-2xl p-3"><QrCode className="h-6 w-6" /></div>
                            <div>
                                <h2 className="ui-text text-lg font-black">Scan QR code</h2>
                                <p className="ui-text-muted mt-1 text-sm">
                                    Scan di Google Authenticator, Authy, 1Password, atau aplikasi TOTP lain.
                                    Setup kedaluwarsa dalam <strong>10 menit</strong>. Kode di app berganti tiap 30 detik — itu normal.
                                    Hapus dulu entri lama untuk akun ini di Authenticator sebelum scan ulang, lalu pakai kode yang tampil
                                    <strong> saat ini</strong> (jangan kode yang sudah berganti).
                                </p>
                            </div>
                        </div>
                        <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
                            <div className="ui-panel-muted ui-border rounded-3xl border p-4">
                                <img src={setup.qrCodeDataUrl} alt="QR Code 2FA" className="h-48 w-48 rounded-2xl bg-white p-2" />
                            </div>
                            <div className="space-y-4">
                                <div>
                                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                        <label className="ui-text block text-sm font-bold">Manual secret</label>
                                        <button type="button" onClick={() => setShowManualSecret((value) => !value)} className="ui-muted-action inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-bold">
                                            {showManualSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                            {showManualSecret ? 'Sembunyikan secret' : 'Tampilkan secret'}
                                        </button>
                                    </div>
                                    {showManualSecret ? (
                                        <div className="ui-panel-muted ui-border mt-2 break-all rounded-xl border px-4 py-3 font-mono text-sm ui-text">
                                            {setup.secret}
                                        </div>
                                    ) : (
                                        <p className="ui-text-muted mt-2 text-sm">Secret disembunyikan. Jangan bagikan secret ini; siapa pun yang melihatnya dapat membuat kode OTP akun Anda.</p>
                                    )}
                                </div>
                                <div>
                                    <label htmlFor="twoFactorCode" className="ui-text block text-sm font-bold">Kode OTP</label>
                                    <input
                                        id="twoFactorCode"
                                        value={code}
                                        onChange={(event) => setCode(normalizeOtpInput(event.target.value))}
                                        className="ui-field mt-2 block w-full max-w-sm rounded-xl px-4 py-3 text-center text-lg font-black tracking-[0.35em]"
                                        placeholder="000000"
                                        inputMode="numeric"
                                        autoComplete="one-time-code"
                                        maxLength={6}
                                        pattern="[0-9]{6}"
                                        required
                                    />
                                </div>
                            </div>
                        </div>
                        <div className="flex flex-col gap-3 sm:flex-row">
                            <button type="submit" disabled={actionLoading || code.length !== 6} className="ui-accent-solid rounded-xl px-4 py-3 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-60">
                                {actionLoading ? 'Memverifikasi...' : 'Verifikasi & aktifkan'}
                            </button>
                            <button type="button" disabled={actionLoading} onClick={() => { setSetup(null); setCode(''); setShowManualSecret(false); }} className="ui-muted-action rounded-xl px-4 py-3 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-60">
                                Batal
                            </button>
                        </div>
                    </form>
                ) : (
                    <div className="space-y-5">
                        <div className="flex items-start gap-4">
                            <div className="ui-warning-chip rounded-2xl p-3"><KeyRound className="h-6 w-6" /></div>
                            <div>
                                <h2 className="ui-text text-lg font-black">Aktifkan perlindungan login</h2>
                                <p className="ui-text-muted mt-1 text-sm">Setup hanya butuh scan QR dan verifikasi satu kode OTP.</p>
                            </div>
                        </div>
                        <button onClick={startSetup} disabled={actionLoading} className="ui-accent-solid rounded-xl px-4 py-3 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-60">
                            {actionLoading ? 'Menyiapkan...' : 'Mulai setup 2FA'}
                        </button>
                    </div>
                )}
            </div>

            {enabled ? <div className="ui-panel ui-border rounded-3xl border p-6 shadow-lg">
                <div className="mb-5"><Link to="/admin/security/sessions" className="ui-accent-solid inline-flex rounded-xl px-4 py-3 text-sm font-bold">Lihat dan kelola perangkat</Link></div>
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="flex items-start gap-4">
                        <div className="ui-warning-chip rounded-2xl p-3"><LogOut className="h-6 w-6" /></div>
                        <div>
                            <h2 className="ui-text text-lg font-black">Manajemen Sesi</h2>
                            <p className="ui-text-muted mt-1 max-w-2xl text-sm leading-relaxed">
                                Cabut semua JWT aktif untuk akun ini. Perangkat lain akan logout otomatis saat request berikutnya, dan perangkat ini akan diarahkan ke login.
                            </p>
                        </div>
                    </div>
                    <button type="button" onClick={() => setConfirmRevokeOpen(true)} disabled={actionLoading} className="ui-warning-action inline-flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-60">
                        <LogOut className="h-4 w-4" /> {actionLoading ? 'Memproses...' : 'Cabut semua sesi'}
                    </button>
                </div>
            </div> : null}

            {confirmRevokeOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
                    <div className="ui-panel ui-border w-full max-w-lg rounded-3xl border p-6 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="revoke-sessions-title">
                        <h2 id="revoke-sessions-title" className="ui-text text-xl font-black">Cabut semua sesi aktif?</h2>
                        <p className="ui-text-muted mt-3 text-sm leading-relaxed">Semua perangkat akan logout. Perangkat ini juga akan diarahkan ke halaman login setelah sesi dicabut.</p>
                        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-end">
                            <button type="button" disabled={actionLoading} onClick={() => setConfirmRevokeOpen(false)} className="ui-muted-action rounded-xl px-4 py-3 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-60">Batal</button>
                            <button type="button" disabled={actionLoading} onClick={revokeSessions} className="ui-warning-action inline-flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-60">
                                <LogOut className="h-4 w-4" /> {actionLoading ? 'Mencabut...' : 'Cabut sesi'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
            {stepUp.dialog}
        </>
    );
}
