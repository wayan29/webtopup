import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
    Calendar,
    Eye,
    EyeOff,
    Loader2,
    Lock,
    Mail,
    MapPin,
    Monitor,
    Phone,
    Save,
    ShieldCheck,
    User
} from 'lucide-react';
import { apiV2 } from '../api';
import { useAuthStore } from '../store/useAuthStore';

type ProfileResponse = {
    profile: {
        id: string;
        name: string;
        email: string;
        phone?: string;
        address?: string;
        role: 'member';
        level: 'basic' | 'gold' | 'platinum';
        balance: number;
        points: number;
        active: boolean;
        createdAt: string;
        updatedAt: string;
    };
};

type LoginActivityResponse = {
    items: Array<{
        _id: string;
        ip: string;
        userAgent: string;
        createdAt: string;
    }>;
};

const getDeviceLabel = (userAgent: string) => {
    const agent = userAgent.toLowerCase();

    const browser = agent.includes('edg/')
        ? 'Edge'
        : agent.includes('chrome/')
            ? 'Chrome'
            : agent.includes('firefox/')
                ? 'Firefox'
                : agent.includes('safari/') && !agent.includes('chrome/')
                    ? 'Safari'
                    : 'Browser';

    const platform = agent.includes('windows')
        ? 'Windows'
        : agent.includes('android')
            ? 'Android'
            : agent.includes('iphone') || agent.includes('ipad') || agent.includes('ios')
                ? 'iOS'
                : agent.includes('mac os')
                    ? 'macOS'
                    : agent.includes('linux')
                        ? 'Linux'
                        : 'Unknown OS';

    return `${platform} - ${browser}`;
};

export default function Account() {
    const { user, syncProfile } = useAuthStore();
    const [initialLoading, setInitialLoading] = useState(true);
    const [loading, setLoading] = useState(false);
    const [passwordLoading, setPasswordLoading] = useState(false);
    const [isEditing, setIsEditing] = useState(false);
    const [showCurrentPassword, setShowCurrentPassword] = useState(false);
    const [showNewPassword, setShowNewPassword] = useState(false);
    const [showConfirmPassword, setShowConfirmPassword] = useState(false);
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
    const [profile, setProfile] = useState({
        name: '',
        email: '',
        phone: '',
        address: '',
        active: true,
        createdAt: '',
        updatedAt: ''
    });
    const [loginActivity, setLoginActivity] = useState<LoginActivityResponse['items']>([]);
    const [passwords, setPasswords] = useState({
        currentPassword: '',
        newPassword: '',
        confirmPassword: ''
    });

    useEffect(() => {
        const loadAccountData = async () => {
            try {
                setInitialLoading(true);
                const [profileRes, activityRes] = await Promise.all([
                    apiV2.get<ProfileResponse>('/users/me/profile'),
                    apiV2.get<LoginActivityResponse>('/users/me/login-activity')
                ]);

                const nextProfile = profileRes.data.profile;
                setProfile({
                    name: nextProfile.name || '',
                    email: nextProfile.email || '',
                    phone: nextProfile.phone || '',
                    address: nextProfile.address || '',
                    active: nextProfile.active !== false,
                    createdAt: nextProfile.createdAt,
                    updatedAt: nextProfile.updatedAt
                });
                setLoginActivity(Array.isArray(activityRes.data.items) ? activityRes.data.items : []);
            } catch (error: any) {
                setMessage({
                    type: 'error',
                    text: error.response?.data?.message || 'Gagal memuat data akun.'
                });
            } finally {
                setInitialLoading(false);
            }
        };

        void loadAccountData();
    }, []);

    const joinDateLabel = useMemo(() => {
        if (!profile.createdAt) return '-';
        return new Date(profile.createdAt).toLocaleDateString('id-ID', {
            day: 'numeric',
            month: 'long',
            year: 'numeric'
        });
    }, [profile.createdAt]);

    const lastUpdatedLabel = useMemo(() => {
        if (!profile.updatedAt) return '-';
        return new Date(profile.updatedAt).toLocaleString('id-ID', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    }, [profile.updatedAt]);

    const handleSave = async () => {
        const normalizedName = profile.name.trim();
        const normalizedEmail = profile.email.trim().toLowerCase();
        const normalizedPhone = profile.phone.trim();
        const normalizedAddress = profile.address.trim();

        if (normalizedName.length < 2) {
            setMessage({ type: 'error', text: 'Nama minimal 2 karakter.' });
            return;
        }

        if (!normalizedEmail) {
            setMessage({ type: 'error', text: 'Email wajib diisi.' });
            return;
        }

        setLoading(true);
        setMessage(null);

        try {
            const payload = {
                name: normalizedName,
                email: normalizedEmail,
                phone: normalizedPhone,
                address: normalizedAddress
            };
            const res = await apiV2
                .put<ProfileResponse>('/users/me/profile', payload);

            const nextProfile = res.data.profile;
            setProfile({
                name: nextProfile.name || '',
                email: nextProfile.email || '',
                phone: nextProfile.phone || '',
                address: nextProfile.address || '',
                active: nextProfile.active !== false,
                createdAt: nextProfile.createdAt,
                updatedAt: nextProfile.updatedAt
            });
            setIsEditing(false);
            setMessage({ type: 'success', text: 'Profil berhasil diperbarui.' });
            await syncProfile();
        } catch (error: any) {
            setMessage({
                type: 'error',
                text: error.response?.data?.message || 'Gagal menyimpan profil.'
            });
        } finally {
            setLoading(false);
        }
    };

    const handleChangePassword = async () => {
        if (passwords.newPassword !== passwords.confirmPassword) {
            setMessage({ type: 'error', text: 'Konfirmasi kata sandi baru tidak cocok.' });
            return;
        }

        if (passwords.newPassword.length < 8) {
            setMessage({ type: 'error', text: 'Kata sandi baru minimal 8 karakter.' });
            return;
        }

        setPasswordLoading(true);
        setMessage(null);

        try {
            await apiV2.put('/users/me/password', passwords);
            setPasswords({ currentPassword: '', newPassword: '', confirmPassword: '' });
            setMessage({ type: 'success', text: 'Kata sandi berhasil diubah.' });
        } catch (error: any) {
            setMessage({
                type: 'error',
                text: error.response?.data?.message || 'Gagal mengubah kata sandi.'
            });
        } finally {
            setPasswordLoading(false);
        }
    };

    if (initialLoading) {
        return (
            <div className="min-h-screen bg-[#1a1a2e] text-white p-4 md:p-6 flex items-center justify-center">
                <Loader2 className="w-8 h-8 text-orange-400 animate-spin" />
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-[#1a1a2e] text-white p-4 md:p-6 space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-white">Akun Saya</h1>
                <p className="text-gray-400 mt-1">Kelola profil, kata sandi, dan aktivitas login akun kamu.</p>
            </div>

            {message && (
                <div className={`rounded-xl border px-4 py-3 text-sm ${
                    message.type === 'success'
                        ? 'border-green-500/30 bg-green-500/10 text-green-300'
                        : 'border-red-500/30 bg-red-500/10 text-red-300'
                }`}>
                    {message.text}
                </div>
            )}

            <div className="bg-[#252540] rounded-xl p-6 border border-[#3a3a5a]">
                <div className="flex flex-col md:flex-row items-center md:items-start gap-6">
                    <div className="w-24 h-24 rounded-full bg-gradient-to-br from-orange-400 to-orange-600 flex items-center justify-center text-3xl font-bold text-white">
                        {profile.name?.charAt(0)?.toUpperCase() || 'U'}
                    </div>

                    <div className="flex-1 text-center md:text-left">
                        <h2 className="text-xl font-bold text-white">{profile.name || 'Member'}</h2>
                        <p className="text-gray-400">{profile.email || '-'}</p>
                        <div className="mt-2 flex flex-wrap gap-2 justify-center md:justify-start">
                            <span className="px-3 py-1 bg-orange-500/20 text-orange-300 text-sm rounded-full font-medium">
                                {(user?.level || 'basic').toUpperCase()}
                            </span>
                            <span className={`px-3 py-1 text-sm rounded-full font-medium ${
                                profile.active
                                    ? 'bg-green-500/20 text-green-300'
                                    : 'bg-red-500/20 text-red-300'
                            }`}>
                                {profile.active ? 'Akun Aktif' : 'Akun Nonaktif'}
                            </span>
                        </div>
                    </div>

                    <button
                        onClick={() => {
                            setIsEditing((current) => !current);
                            setMessage(null);
                        }}
                        className="px-4 py-2 bg-[#3a3a5a] hover:bg-[#4a4a6a] text-white rounded-lg font-medium text-sm transition-colors"
                    >
                        {isEditing ? 'Batal' : 'Edit Profil'}
                    </button>
                </div>
            </div>

            <div className="bg-[#252540] rounded-xl p-6 border border-[#3a3a5a]">
                <div className="flex items-center justify-between gap-4 mb-4">
                    <div>
                        <h3 className="text-lg font-semibold text-white">Informasi Profil</h3>
                        <p className="text-sm text-gray-400">Hanya field yang benar-benar dipakai sistem yang disimpan di sini.</p>
                    </div>
                    <div className="text-right text-xs text-gray-500">
                        <p>Update terakhir</p>
                        <p className="mt-1 text-gray-300">{lastUpdatedLabel}</p>
                    </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <FieldBlock icon={User} label="Nama Lengkap">
                        {isEditing ? (
                            <input
                                type="text"
                                value={profile.name}
                                onChange={(event) => setProfile((current) => ({ ...current, name: event.target.value }))}
                                className="w-full bg-[#1a1a2e] border border-[#3a3a5a] rounded-lg px-4 py-3 text-white focus:outline-none focus:border-orange-500"
                            />
                        ) : (
                            <p className="text-white font-medium py-3">{profile.name || '-'}</p>
                        )}
                    </FieldBlock>

                    <FieldBlock icon={Mail} label="Email">
                        {isEditing ? (
                            <input
                                type="email"
                                value={profile.email}
                                onChange={(event) => setProfile((current) => ({ ...current, email: event.target.value }))}
                                autoCapitalize="none"
                                className="w-full bg-[#1a1a2e] border border-[#3a3a5a] rounded-lg px-4 py-3 text-white focus:outline-none focus:border-orange-500"
                            />
                        ) : (
                            <p className="text-white font-medium py-3">{profile.email || '-'}</p>
                        )}
                    </FieldBlock>

                    <FieldBlock icon={Phone} label="Nomor Telepon">
                        {isEditing ? (
                            <input
                                type="tel"
                                value={profile.phone}
                                onChange={(event) => setProfile((current) => ({ ...current, phone: event.target.value }))}
                                className="w-full bg-[#1a1a2e] border border-[#3a3a5a] rounded-lg px-4 py-3 text-white focus:outline-none focus:border-orange-500"
                            />
                        ) : (
                            <p className="text-white font-medium py-3">{profile.phone || '-'}</p>
                        )}
                    </FieldBlock>

                    <FieldBlock icon={MapPin} label="Alamat">
                        {isEditing ? (
                            <input
                                type="text"
                                value={profile.address}
                                onChange={(event) => setProfile((current) => ({ ...current, address: event.target.value }))}
                                className="w-full bg-[#1a1a2e] border border-[#3a3a5a] rounded-lg px-4 py-3 text-white focus:outline-none focus:border-orange-500"
                            />
                        ) : (
                            <p className="text-white font-medium py-3">{profile.address || '-'}</p>
                        )}
                    </FieldBlock>

                    <FieldBlock icon={Calendar} label="Tanggal Bergabung">
                        <p className="text-white font-medium py-3">{joinDateLabel}</p>
                    </FieldBlock>

                    <FieldBlock icon={ShieldCheck} label="Status Akun">
                        <p className="py-3">
                            <span className={`px-3 py-1 text-sm rounded-full font-medium ${
                                profile.active
                                    ? 'bg-green-500/20 text-green-300'
                                    : 'bg-red-500/20 text-red-300'
                            }`}>
                                {profile.active ? 'Aktif' : 'Nonaktif'}
                            </span>
                        </p>
                    </FieldBlock>
                </div>

                {isEditing && (
                    <div className="flex justify-end mt-6">
                        <button
                            onClick={handleSave}
                            disabled={loading}
                            className="bg-orange-500 hover:bg-orange-600 text-white px-6 py-3 rounded-lg font-semibold text-sm transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {loading ? (
                                <>
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                    Menyimpan...
                                </>
                            ) : (
                                <>
                                    <Save className="w-4 h-4" />
                                    Simpan Profil
                                </>
                            )}
                        </button>
                    </div>
                )}
            </div>

            <div className="bg-[#252540] rounded-xl p-6 border border-[#3a3a5a]">
                <div className="flex items-center gap-3 mb-4">
                    <div className="w-10 h-10 rounded-full bg-orange-500/20 flex items-center justify-center">
                        <Lock className="w-5 h-5 text-orange-400" />
                    </div>
                    <div>
                        <h3 className="text-lg font-semibold text-white">Ubah Kata Sandi</h3>
                        <p className="text-sm text-gray-400">Password baru minimal 8 karakter dan harus berbeda dari yang sekarang.</p>
                    </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <PasswordField
                        label="Kata Sandi Saat Ini"
                        value={passwords.currentPassword}
                        onChange={(value) => setPasswords((current) => ({ ...current, currentPassword: value }))}
                        show={showCurrentPassword}
                        onToggle={() => setShowCurrentPassword((current) => !current)}
                    />
                    <PasswordField
                        label="Kata Sandi Baru"
                        value={passwords.newPassword}
                        onChange={(value) => setPasswords((current) => ({ ...current, newPassword: value }))}
                        show={showNewPassword}
                        onToggle={() => setShowNewPassword((current) => !current)}
                    />
                    <PasswordField
                        label="Konfirmasi Kata Sandi Baru"
                        value={passwords.confirmPassword}
                        onChange={(value) => setPasswords((current) => ({ ...current, confirmPassword: value }))}
                        show={showConfirmPassword}
                        onToggle={() => setShowConfirmPassword((current) => !current)}
                    />
                </div>

                <div className="flex justify-end mt-6">
                    <button
                        onClick={handleChangePassword}
                        disabled={passwordLoading || !passwords.currentPassword || !passwords.newPassword || !passwords.confirmPassword}
                        className="bg-orange-500 hover:bg-orange-600 text-white px-6 py-3 rounded-lg font-semibold text-sm transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {passwordLoading ? (
                            <>
                                <Loader2 className="w-4 h-4 animate-spin" />
                                Mengubah...
                            </>
                        ) : (
                            <>
                                <Lock className="w-4 h-4" />
                                Ubah Kata Sandi
                            </>
                        )}
                    </button>
                </div>
            </div>

            <div className="bg-[#252540] rounded-xl p-6 border border-[#3a3a5a]">
                <div className="flex items-center gap-3 mb-4">
                    <div className="w-10 h-10 rounded-full bg-blue-500/20 flex items-center justify-center">
                        <Monitor className="w-5 h-5 text-blue-400" />
                    </div>
                    <div>
                        <h3 className="text-lg font-semibold text-white">Aktivitas Login Terbaru</h3>
                        <p className="text-sm text-gray-400">Daftar login sukses terbaru akun kamu. Jika ada aktivitas yang tidak dikenal, segera ubah kata sandi.</p>
                    </div>
                </div>

                <div className="space-y-3">
                    {loginActivity.length === 0 ? (
                        <div className="rounded-lg border border-[#3a3a5a] bg-[#1a1a2e] px-4 py-6 text-sm text-gray-400">
                            Belum ada riwayat login yang bisa ditampilkan.
                        </div>
                    ) : (
                        loginActivity.map((item, index) => (
                            <div
                                key={item._id}
                                className="flex flex-col gap-3 rounded-lg border border-[#3a3a5a] bg-[#1a1a2e] px-4 py-4 md:flex-row md:items-center md:justify-between"
                            >
                                <div className="flex items-start gap-4">
                                    <div className="w-10 h-10 rounded-full bg-[#3a3a5a] flex items-center justify-center">
                                        <Monitor className="w-5 h-5 text-gray-300" />
                                    </div>
                                    <div>
                                        <div className="flex flex-wrap items-center gap-2">
                                            <p className="text-white font-medium">{getDeviceLabel(item.userAgent)}</p>
                                            {index === 0 && (
                                                <span className="px-2 py-0.5 bg-green-500/20 text-green-300 text-xs rounded-full font-medium">
                                                    Login terbaru
                                                </span>
                                            )}
                                        </div>
                                        <p className="text-sm text-gray-400 mt-1">{item.ip || '-'}</p>
                                        <p className="text-xs text-gray-500 mt-1">{new Date(item.createdAt).toLocaleString('id-ID')}</p>
                                    </div>
                                </div>
                                <p className="text-xs text-gray-500 md:max-w-xs">
                                    {item.userAgent || 'User agent tidak tersedia'}
                                </p>
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    );
}

function FieldBlock({
    icon: Icon,
    label,
    children
}: {
    icon: typeof User;
    label: string;
    children: ReactNode;
}) {
    return (
        <div className="space-y-2">
            <label className="flex items-center gap-2 text-gray-400 text-sm">
                <Icon className="w-4 h-4" />
                {label}
            </label>
            {children}
        </div>
    );
}

function PasswordField({
    label,
    value,
    onChange,
    show,
    onToggle
}: {
    label: string;
    value: string;
    onChange: (value: string) => void;
    show: boolean;
    onToggle: () => void;
}) {
    return (
        <div className="space-y-2">
            <label className="text-gray-400 text-sm">{label}</label>
            <div className="relative">
                <input
                    type={show ? 'text' : 'password'}
                    value={value}
                    onChange={(event) => onChange(event.target.value)}
                    className="w-full bg-[#1a1a2e] border border-[#3a3a5a] rounded-lg px-4 py-3 pr-10 text-white focus:outline-none focus:border-orange-500"
                />
                <button
                    type="button"
                    onClick={onToggle}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white"
                >
                    {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
            </div>
        </div>
    );
}
