import { useEffect, useState } from 'react';
import { Camera, Eye, EyeOff, Loader2, Mail, Save, Trash2,} from 'lucide-react';
import { apiV2 } from '../../api';
import { multipartRequestConfig } from '../../api/multipartRequest';
import { StaffAvatar } from '../../components/admin/StaffAvatar';
import { useStepUpOrchestration } from '../../auth/useStepUpOrchestration';
import { stepUpActionErrorMessage } from '../../auth/withStepUp';
import { useAuthStore } from '../../store/useAuthStore';
import Security from './Security';

type StaffProfile = {
    id: string;
    name: string;
    email: string;
    avatarUrl?: string;
    role: string;
    twoFactorEnabled: boolean;
};

const ROLE_LABELS: Record<string, string> = {
    owner: 'Owner',
    admin: 'Admin',
    cs: 'Customer Service',
};

const emptyPasswords = { currentPassword: '', newPassword: '', confirmPassword: '' };

export default function Profile() {
    const stepUp = useStepUpOrchestration();
    const syncProfile = useAuthStore((state) => state.syncProfile);
    const logout = useAuthStore((state) => state.logout);
    const [profile, setProfile] = useState<StaffProfile | null>(null);
    const [form, setForm] = useState({ name: '', email: '' });
    const [passwords, setPasswords] = useState(emptyPasswords);
    const [showCurrent, setShowCurrent] = useState(false);
    const [showNext, setShowNext] = useState(false);
    const [loading, setLoading] = useState(true);
    const [savingProfile, setSavingProfile] = useState(false);
    const [avatarBusy, setAvatarBusy] = useState(false);
    const [savingPassword, setSavingPassword] = useState(false);
    const [profileMessage, setProfileMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
    const [passwordMessage, setPasswordMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

    const loadProfile = async () => {
        setLoading(true);
        try {
            const res = await apiV2.get<{ profile: StaffProfile }>('/staff/me/profile');
            setProfile(res.data.profile);
            setForm({ name: res.data.profile.name || '', email: res.data.profile.email || '' });
        } catch (err: any) {
            setProfileMessage({
                type: 'err',
                text: err.response?.data?.message || 'Gagal memuat profil.',
            });
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadProfile();
    }, []);

    useEffect(() => {
        const handler = () => loadProfile();
        window.addEventListener('admin:refresh-current-page', handler);
        return () => window.removeEventListener('admin:refresh-current-page', handler);
    }, []);

    const identityDirty =
        !!profile &&
        (form.name.trim() !== profile.name ||
            form.email.trim().toLowerCase() !== profile.email.toLowerCase());

    // Applies immediately rather than waiting for a Save button. Picking a file is already an
    // explicit action, and a second Save step is exactly what made an earlier email edit look
    // saved when it was not.
    const handleAvatarPick = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        if (file.size > 2 * 1024 * 1024) {
            setProfileMessage({ type: 'err', text: 'Ukuran foto maksimal 2MB.' });
            return;
        }
        setAvatarBusy(true);
        setProfileMessage(null);
        try {
            const body = new FormData();
            body.append('file', file);
            const res = await apiV2.post<{ avatarUrl: string }>(
                '/staff/me/avatar',
                body,
                multipartRequestConfig()
            );
            setProfile((current) => (current ? { ...current, avatarUrl: res.data.avatarUrl } : current));
            setProfileMessage({ type: 'ok', text: 'Foto profil berhasil diperbarui.' });
            await syncProfile();
        } catch (err: any) {
            setProfileMessage({
                type: 'err',
                text: err.response?.data?.message || 'Gagal mengunggah foto.',
            });
        } finally {
            setAvatarBusy(false);
        }
    };

    const handleAvatarRemove = async () => {
        setAvatarBusy(true);
        setProfileMessage(null);
        try {
            await apiV2.delete('/staff/me/avatar');
            setProfile((current) => (current ? { ...current, avatarUrl: '' } : current));
            setProfileMessage({ type: 'ok', text: 'Foto profil dihapus.' });
            await syncProfile();
        } catch (err: any) {
            setProfileMessage({
                type: 'err',
                text: err.response?.data?.message || 'Gagal menghapus foto.',
            });
        } finally {
            setAvatarBusy(false);
        }
    };

    const handleSaveIdentity = async () => {
        if (!identityDirty) return;
        setSavingProfile(true);
        setProfileMessage(null);
        try {
            const res = await stepUp.run('security.password', (config) =>
                apiV2.put<{ profile: StaffProfile }>(
                    '/staff/me/profile',
                    { name: form.name.trim(), email: form.email.trim() },
                    config,
                ),
            );
            setProfile(res.data.profile);
            setForm({ name: res.data.profile.name || '', email: res.data.profile.email || '' });
            setProfileMessage({ type: 'ok', text: 'Profil berhasil diperbarui.' });
            await syncProfile();
        } catch (err: any) {
            const text = stepUpActionErrorMessage(err, 'Gagal menyimpan profil.');
            if (text) setProfileMessage({ type: 'err', text });
        } finally {
            setSavingProfile(false);
        }
    };

    const handleChangePassword = async () => {
        if (passwords.newPassword !== passwords.confirmPassword) {
            setPasswordMessage({ type: 'err', text: 'Konfirmasi password baru tidak cocok.' });
            return;
        }
        if (passwords.newPassword.length < 12) {
            setPasswordMessage({ type: 'err', text: 'Password baru minimal 12 karakter.' });
            return;
        }
        setSavingPassword(true);
        setPasswordMessage(null);
        try {
            await stepUp.run('security.password', (config) =>
                apiV2.put('/staff/me/password', passwords, config),
            );
            // The server increments the account-wide session version, so this credential is no
            // longer valid either. Clear it immediately instead of leaving an apparently signed-in
            // page that fails on its next API request. logout() resolves staff to /staff/login.
            await logout();
        } catch (err: any) {
            const text = stepUpActionErrorMessage(err, 'Gagal mengubah password.');
            if (text) setPasswordMessage({ type: 'err', text });
        } finally {
            setSavingPassword(false);
        }
    };

    const messageClass = (type: 'ok' | 'err') =>
        type === 'ok'
            ? 'ui-success-chip rounded-2xl px-4 py-3 text-sm font-bold'
            : 'ui-danger-chip rounded-2xl px-4 py-3 text-sm font-bold';

    if (loading) {
        return (
            <div className="flex min-h-[40vh] items-center justify-center">
                <Loader2 className="ui-accent-text h-8 w-8 animate-spin" aria-label="Memuat profil" />
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <div className="ui-card-gradient ui-border rounded-3xl border p-6 shadow-xl">
                <h2 className="ui-text text-lg font-black">Identitas Akun</h2>
                <p className="ui-text-muted mt-1 text-sm">Email ini dipakai untuk masuk ke panel admin.</p>
                {profile ? (
                    <p className="ui-text-muted mt-2 text-sm">
                        Peran: <span className="ui-text font-bold">{ROLE_LABELS[profile.role] || profile.role}</span>
                        <span> (hanya dapat diubah lewat Manajemen Tim)</span>
                    </p>
                ) : null}
                <div className="mt-5 flex flex-wrap items-center gap-4">
                    <StaffAvatar
                        avatarUrl={profile?.avatarUrl}
                        initials={(profile?.name || '?').trim().charAt(0).toUpperCase()}
                        alt="Foto profil Anda"
                        className="ui-accent-solid ui-border relative flex h-20 w-20 items-center justify-center overflow-hidden rounded-full border text-xl font-black"
                    />
                    <div className="flex flex-wrap items-center gap-2">
                        <label className="ui-panel ui-border ui-text inline-flex cursor-pointer items-center gap-2 rounded-xl border px-4 py-2 text-sm font-bold">
                            {avatarBusy ? (
                                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                            ) : (
                                <Camera className="h-4 w-4" aria-hidden="true" />
                            )}
                            Unggah Foto
                            <input
                                type="file"
                                accept="image/jpeg,image/png,image/webp"
                                className="hidden"
                                disabled={avatarBusy}
                                onChange={handleAvatarPick}
                            />
                        </label>
                        {profile?.avatarUrl ? (
                            <button
                                type="button"
                                onClick={handleAvatarRemove}
                                disabled={avatarBusy}
                                className="ui-panel ui-border ui-text inline-flex items-center gap-2 rounded-xl border px-4 py-2 text-sm font-bold disabled:opacity-50"
                            >
                                <Trash2 className="h-4 w-4" aria-hidden="true" />
                                Hapus Foto
                            </button>
                        ) : null}
                        <p className="ui-text-muted w-full text-xs">JPEG, PNG, atau WebP. Maksimal 2MB.</p>
                    </div>
                </div>
                {profileMessage ? (
                    <div role="status" aria-live="polite" className={`mt-4 ${messageClass(profileMessage.type)}`}>
                        {profileMessage.text}
                    </div>
                ) : null}
                <div className="mt-5 grid gap-4 sm:grid-cols-2">
                    <div>
                        <label htmlFor="staff-name" className="ui-text-muted block text-xs font-bold uppercase tracking-wider">
                            Nama
                        </label>
                        <input
                            id="staff-name"
                            type="text"
                            value={form.name}
                            onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                            className="ui-panel ui-border ui-text mt-2 w-full rounded-xl border px-4 py-3 text-sm"
                            autoComplete="name"
                        />
                    </div>
                    <div>
                        <label htmlFor="staff-email" className="ui-text-muted block text-xs font-bold uppercase tracking-wider">
                            Email
                        </label>
                        <div className="relative mt-2">
                            <Mail className="ui-text-muted pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2" aria-hidden="true" />
                            <input
                                id="staff-email"
                                type="email"
                                value={form.email}
                                onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
                                className="ui-panel ui-border ui-text w-full rounded-xl border px-4 py-3 pl-11 text-sm"
                                autoComplete="email"
                            />
                        </div>
                    </div>
                </div>
                <button
                    type="button"
                    onClick={handleSaveIdentity}
                    disabled={savingProfile || !identityDirty}
                    className="ui-accent-solid mt-5 inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-bold disabled:opacity-50"
                >
                    {savingProfile ? (
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : (
                        <Save className="h-4 w-4" aria-hidden="true" />
                    )}
                    Simpan Perubahan
                </button>
            </div>

            <div className="ui-card-gradient ui-border rounded-3xl border p-6 shadow-xl">
                <h2 className="ui-text text-lg font-black">Ganti Password</h2>
                <p className="ui-text-muted mt-1 text-sm">
                    Minimal 12 karakter. Mengganti password akan mencabut sesi Anda di perangkat lain.
                </p>
                {passwordMessage ? (
                    <div role="status" aria-live="polite" className={`mt-4 ${messageClass(passwordMessage.type)}`}>
                        {passwordMessage.text}
                    </div>
                ) : null}
                <div className="mt-5 space-y-4">
                    <div>
                        <label htmlFor="staff-current-password" className="ui-text-muted block text-xs font-bold uppercase tracking-wider">
                            Password Saat Ini
                        </label>
                        <div className="relative mt-2">
                            <input
                                id="staff-current-password"
                                type={showCurrent ? 'text' : 'password'}
                                value={passwords.currentPassword}
                                onChange={(event) =>
                                    setPasswords((current) => ({ ...current, currentPassword: event.target.value }))
                                }
                                className="ui-panel ui-border ui-text w-full rounded-xl border px-4 py-3 pr-12 text-sm"
                                autoComplete="current-password"
                            />
                            <button
                                type="button"
                                onClick={() => setShowCurrent((value) => !value)}
                                className="ui-text-muted absolute right-3 top-1/2 -translate-y-1/2 rounded-lg p-1"
                                aria-label={showCurrent ? 'Sembunyikan password saat ini' : 'Tampilkan password saat ini'}
                            >
                                {showCurrent ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                            </button>
                        </div>
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2">
                        <div>
                            <label htmlFor="staff-new-password" className="ui-text-muted block text-xs font-bold uppercase tracking-wider">
                                Password Baru
                            </label>
                            <div className="relative mt-2">
                                <input
                                    id="staff-new-password"
                                    type={showNext ? 'text' : 'password'}
                                    value={passwords.newPassword}
                                    onChange={(event) =>
                                        setPasswords((current) => ({ ...current, newPassword: event.target.value }))
                                    }
                                    className="ui-panel ui-border ui-text w-full rounded-xl border px-4 py-3 pr-12 text-sm"
                                    autoComplete="new-password"
                                />
                                <button
                                    type="button"
                                    onClick={() => setShowNext((value) => !value)}
                                    className="ui-text-muted absolute right-3 top-1/2 -translate-y-1/2 rounded-lg p-1"
                                    aria-label={showNext ? 'Sembunyikan password baru' : 'Tampilkan password baru'}
                                >
                                    {showNext ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                </button>
                            </div>
                        </div>
                        <div>
                            <label htmlFor="staff-confirm-password" className="ui-text-muted block text-xs font-bold uppercase tracking-wider">
                                Konfirmasi Password Baru
                            </label>
                            <input
                                id="staff-confirm-password"
                                type={showNext ? 'text' : 'password'}
                                value={passwords.confirmPassword}
                                onChange={(event) =>
                                    setPasswords((current) => ({ ...current, confirmPassword: event.target.value }))
                                }
                                className="ui-panel ui-border ui-text mt-2 w-full rounded-xl border px-4 py-3 text-sm"
                                autoComplete="new-password"
                            />
                        </div>
                    </div>
                </div>
                <button
                    type="button"
                    onClick={handleChangePassword}
                    disabled={
                        savingPassword ||
                        !passwords.currentPassword ||
                        !passwords.newPassword ||
                        !passwords.confirmPassword
                    }
                    className="ui-accent-solid mt-5 inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-bold disabled:opacity-50"
                >
                    {savingPassword ? (
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : (
                        <Save className="h-4 w-4" aria-hidden="true" />
                    )}
                    Ubah Password
                </button>
            </div>

            {/* Reused as-is rather than reimplemented: this panel carries the enrollment flow that
                staff who are past the 2FA deadline are redirected here to complete. */}
            <Security />

            {stepUp.dialog}
        </div>
    );
}
