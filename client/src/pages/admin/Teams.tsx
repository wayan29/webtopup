import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, ShieldCheck, ShieldX, Trash2, Edit, X, Eye, EyeOff, History, Search, RefreshCw } from 'lucide-react';
import { apiV2 } from '../../api';
import { useStepUpOrchestration } from '../../auth/useStepUpOrchestration';
import { stepUpActionErrorMessage } from '../../auth/withStepUp';
import TeamAccessDialog, { type TeamAccessDialogMember } from '../../components/admin/TeamAccessDialog';
import TeamAccessPreview from '../../components/admin/TeamAccessPreview';
import {
    getEffectiveTeamAccess,
    normalizeTeamPermissions,
    summarizeEffectiveTeamAccess,
    type TeamPermissionKey,
    type TeamPermissions,
} from '../../lib/teamAccess.ts';
import { useAuthStore } from '../../store/useAuthStore';

interface LoginLog {
    _id: string;
    email: string;
    role: string;
    ip: string;
    userAgent: string;
    status: 'success' | 'failed';
    failReason?: string;
    createdAt: string;
}

type Permissions = TeamPermissions;

interface TeamMember {
    _id: string;
    name: string;
    email: string;
    role: 'owner' | 'admin' | 'cs';
    active: boolean;
    twoFactorEnabled?: boolean;
    permissions: Permissions;
    createdAt: string;
    updatedAt?: string;
    createdBy?: {
        _id?: string;
        name?: string;
        email?: string;
        role?: string;
    } | null;
}

interface TeamSummary {
    total: number;
    active: number;
    inactive: number;
    owner: number;
    admin: number;
    cs: number;
}

interface TeamAuditLog {
    _id: string;
    actorName: string;
    actorEmail: string;
    targetName: string;
    targetEmail: string;
    targetRole: 'owner' | 'admin' | 'cs' | 'member';
    action: 'create' | 'update' | 'activate' | 'deactivate' | 'archive';
    summary: string;
    createdAt: string;
}

const defaultPermissions: Permissions = {
    viewDashboard: true,
    viewReports: false,
    viewTransactions: false,
    processManualTransaction: false,
    viewDeposits: false,
    approveDeposits: false,
    viewProducts: false,
    manageProducts: false,
    manageVouchers: false,
    viewPayment: false,
    managePayment: false,
    viewUsers: false,
    manageUsers: false,
    viewTeam: false,
    manageTeam: false,
    viewSettings: false,
    manageSettings: false,
    viewVendors: false,
    manageVendors: false,
};

const adminDefaultPermissions: Permissions = {
    viewDashboard: true,
    viewReports: true,
    viewTransactions: true,
    processManualTransaction: true,
    viewDeposits: true,
    approveDeposits: true,
    viewProducts: true,
    manageProducts: true,
    manageVouchers: true,
    viewPayment: true,
    managePayment: true,
    viewUsers: true,
    manageUsers: true,
    viewTeam: true,
    manageTeam: false,
    viewSettings: false,
    manageSettings: false,
    viewVendors: true,
    manageVendors: false,
};

const csDefaultPermissions: Permissions = {
    viewDashboard: true,
    viewReports: false,
    viewTransactions: true,
    processManualTransaction: true,
    viewDeposits: true,
    approveDeposits: false,
    viewProducts: false,
    manageProducts: false,
    manageVouchers: false,
    viewPayment: false,
    managePayment: false,
    viewUsers: false,
    manageUsers: false,
    viewTeam: false,
    manageTeam: false,
    viewSettings: false,
    manageSettings: false,
    viewVendors: false,
    manageVendors: false,
};

const permissionGroups = [
    {
        name: 'Dashboard & Laporan',
        permissions: [
            { key: 'viewDashboard', label: 'Lihat Dashboard' },
            { key: 'viewReports', label: 'Lihat Laporan Penjualan' },
        ]
    },
    {
        name: 'Transaksi',
        permissions: [
            { key: 'viewTransactions', label: 'Lihat Transaksi' },
            { key: 'processManualTransaction', label: 'Proses Transaksi Manual' },
        ]
    },
    {
        name: 'Deposit',
        permissions: [
            { key: 'viewDeposits', label: 'Lihat Deposit' },
            { key: 'approveDeposits', label: 'Approve/Reject Deposit' },
        ]
    },
    {
        name: 'Produk',
        permissions: [
            { key: 'viewProducts', label: 'Lihat Produk' },
            { key: 'manageProducts', label: 'Kelola Produk' },
            { key: 'manageVouchers', label: 'Kelola Voucher Saldo' },
        ]
    },
    {
        name: 'Pembayaran',
        permissions: [
            { key: 'viewPayment', label: 'Lihat Pembayaran' },
            { key: 'managePayment', label: 'Kelola Pembayaran' },
        ]
    },
    {
        name: 'Member',
        permissions: [
            { key: 'viewUsers', label: 'Lihat Member' },
            { key: 'manageUsers', label: 'Kelola Member' },
        ]
    },
    {
        name: 'Tim',
        permissions: [
            { key: 'viewTeam', label: 'Lihat Tim' },
            { key: 'manageTeam', label: 'Kelola Tim' },
        ]
    },
    {
        name: 'Settings & Vendor',
        permissions: [
            { key: 'viewSettings', label: 'Lihat Settings' },
            { key: 'manageSettings', label: 'Kelola Settings' },
            { key: 'viewVendors', label: 'Lihat Vendor' },
            { key: 'manageVendors', label: 'Kelola Vendor' },
        ]
    },
];

interface FormData {
    name: string;
    email: string;
    password: string;
    role: 'admin' | 'cs';
    permissions: Permissions;
}

const defaultForm: FormData = {
    name: '',
    email: '',
    password: '',
    role: 'cs',
    permissions: { ...csDefaultPermissions },
};

const normalizePermissions = (permissions: Permissions | null | undefined): Permissions => (
    normalizeTeamPermissions(permissions)
);

export default function Teams() {
    const stepUp = useStepUpOrchestration();
    const { user, hasPermission } = useAuthStore();
    const [members, setMembers] = useState<TeamMember[]>([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [summary, setSummary] = useState<TeamSummary>({
        total: 0,
        active: 0,
        inactive: 0,
        owner: 0,
        admin: 0,
        cs: 0
    });
    const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
    const [showModal, setShowModal] = useState(false);
    const [editingMember, setEditingMember] = useState<TeamMember | null>(null);
    const [form, setForm] = useState<FormData>(defaultForm);
    const [showPassword, setShowPassword] = useState(false);
    const [accessMember, setAccessMember] = useState<TeamAccessDialogMember | null>(null);

    // Login logs state
    const [showLogsModal, setShowLogsModal] = useState(false);
    const [logsMember, setLogsMember] = useState<TeamMember | null>(null);
    const [loginLogs, setLoginLogs] = useState<LoginLog[]>([]);
    const [logsLoading, setLogsLoading] = useState(false);
    const [logsPagination, setLogsPagination] = useState({ currentPage: 1, totalPages: 1, totalLogs: 0 });
    const [showAllLogsModal, setShowAllLogsModal] = useState(false);
    const [allLoginLogs, setAllLoginLogs] = useState<LoginLog[]>([]);
    const [allLogsLoading, setAllLogsLoading] = useState(false);
    const [allLogsPagination, setAllLogsPagination] = useState({ currentPage: 1, totalPages: 1, totalLogs: 0 });
    const [auditLogs, setAuditLogs] = useState<TeamAuditLog[]>([]);
    const [auditLoading, setAuditLoading] = useState(false);
    const [confirmAction, setConfirmAction] = useState<{
        type: 'archive' | 'reset-2fa';
        member: TeamMember;
    } | null>(null);
    const latestMembersRequestId = useRef(0);

    const isOwner = user?.role === 'owner';
    const canManageTeam = isOwner || hasPermission('manageTeam');

    const canManageMember = (member: TeamMember) => {
        if (!canManageTeam) return false;
        if (member.role === 'owner') return false;
        if (isOwner) return true;
        return member.role === 'cs';
    };

    const canViewMemberLogs = (member: TeamMember) => {
        if (!canManageTeam) return false;
        if (isOwner) return true;
        return member.role === 'cs';
    };

    const accessSummaryFor = (member: TeamMember) => summarizeEffectiveTeamAccess(getEffectiveTeamAccess({
        role: member.role,
        active: member.active,
        permissions: member.permissions,
    }));

    const accessSummaryLabelFor = (member: TeamMember) => {
        if (member.role === 'owner') {
            return member.active ? 'Akses penuh' : 'Akses penuh dikonfigurasi · ditangguhkan';
        }
        if (!member.active) return 'Akses ditangguhkan';
        const summary = accessSummaryFor(member);
        if (summary.labels.length === 0) return 'Tidak ada akses operasional';
        const remaining = summary.remainingGroupCount > 0 ? ` · +${summary.remainingGroupCount} area akses` : '';
        return `${summary.labels.join(' · ')}${remaining}`;
    };

    const closeTeamModal = () => {
        setShowModal(false);
        setEditingMember(null);
        setForm(defaultForm);
        setShowPassword(false);
    };

    const fetchMembers = useCallback(async () => {
        const requestId = latestMembersRequestId.current + 1;
        latestMembersRequestId.current = requestId;

        try {
            setLoading(true);
            const res = await apiV2
                .get('/teams/admin/list');
            if (requestId !== latestMembersRequestId.current) return;
            setMembers(res.data.members || []);
            setSummary(res.data.summary || {
                total: 0,
                active: 0,
                inactive: 0,
                owner: 0,
                admin: 0,
                cs: 0
            });
        } catch (error: any) {
            if (requestId !== latestMembersRequestId.current) return;
            if (error.response?.status !== 403) {
                console.error('Failed to load team members', error);
                setFeedback({ type: 'error', text: error.response?.data?.message || 'Gagal memuat daftar tim' });
            }
        } finally {
            if (requestId === latestMembersRequestId.current) {
                setLoading(false);
            }
        }
    }, []);

    useEffect(() => {
        fetchMembers();
    }, [fetchMembers]);

    useEffect(() => {
        const handler = () => fetchMembers();
        window.addEventListener('admin:refresh-current-page', handler);
        return () => window.removeEventListener('admin:refresh-current-page', handler);
    }, [fetchMembers]);

    const filteredMembers = useMemo(() => {
        const keyword = search.trim().toLowerCase();
        if (!keyword) return members;
        return members.filter((member) =>
            member.name.toLowerCase().includes(keyword)
            || member.email.toLowerCase().includes(keyword)
            || member.role.toLowerCase().includes(keyword)
        );
    }, [members, search]);

    const fetchAuditLogs = useCallback(async () => {
        if (!canManageTeam) {
            setAuditLogs([]);
            return;
        }

        try {
            setAuditLoading(true);
            const res = await apiV2
                .get('/teams/admin/audit-logs?limit=8');
            setAuditLogs(res.data.logs || []);
        } catch (error) {
            console.error('Failed to fetch team audit logs', error);
        } finally {
            setAuditLoading(false);
        }
    }, [canManageTeam]);

    useEffect(() => {
        if (canManageTeam) {
            fetchAuditLogs();
        }
    }, [canManageTeam, fetchAuditLogs]);

    const handleRoleChange = (role: 'admin' | 'cs') => {
        if (!isOwner && role === 'admin') return;
        const newPermissions = normalizePermissions(role === 'admin' ? { ...adminDefaultPermissions } : { ...csDefaultPermissions });
        setForm({ ...form, role, permissions: newPermissions });
    };

    const handlePermissionChange = (key: keyof Permissions) => {
        const nextPermissions = {
            ...form.permissions,
            [key]: !form.permissions[key]
        };

        if (key === 'viewTeam' && form.permissions.viewTeam) {
            nextPermissions.manageTeam = false;
        }

        setForm({
            ...form,
            permissions: normalizePermissions(nextPermissions)
        });
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!canManageTeam) {
            setFeedback({ type: 'error', text: 'Akun ini hanya dapat melihat tim. Aksi tambah dan edit disembunyikan.' });
            return;
        }
        if (editingMember && !canManageMember(editingMember)) {
            setFeedback({ type: 'error', text: 'Anda tidak memiliki izin untuk mengelola anggota tim ini.' });
            return;
        }
        try {
            if (editingMember) {
                const updateData: any = {
                    name: form.name,
                    email: form.email,
                    role: form.role,
                    permissions: form.permissions,
                };
                if (form.password) {
                    updateData.password = form.password;
                }
                await stepUp.run('team.manage_privileged', (config) =>
                    apiV2.put(`/teams/${editingMember._id}`, updateData, config as never),
                );
            } else {
                await stepUp.run('team.manage_privileged', (config) =>
                    apiV2.post('/teams', form, config as never),
                );
            }
            fetchMembers();
            fetchAuditLogs();
            closeTeamModal();
            setFeedback({
                type: 'success',
                text: editingMember ? 'Perubahan anggota tim berhasil disimpan.' : 'Anggota tim berhasil ditambahkan.'
            });
        } catch (error: unknown) {
            console.error('Failed to save team member', error);
            const text = stepUpActionErrorMessage(error, 'Gagal menyimpan anggota tim');
            if (text) setFeedback({ type: 'error', text });
        }
    };

    const handleEdit = (member: TeamMember) => {
        if (!canManageMember(member)) return;
        setEditingMember(member);
        setForm({
            name: member.name,
            email: member.email,
            password: '',
            role: member.role as 'admin' | 'cs',
            permissions: normalizePermissions(member.permissions || defaultPermissions),
        });
        setShowPassword(false);
        setShowModal(true);
    };

    const handleToggleActive = async (member: TeamMember) => {
        if (!canManageMember(member)) {
            setFeedback({ type: 'error', text: 'Anda tidak memiliki izin untuk mengubah status anggota tim ini.' });
            return;
        }
        try {
            await stepUp.run('team.manage_privileged', (config) =>
                apiV2.put(`/teams/${member._id}/toggle`, {}, config as never),
            );
            fetchMembers();
            fetchAuditLogs();
            setFeedback({
                type: 'success',
                text: member.active ? 'Akun tim berhasil dinonaktifkan.' : 'Akun tim berhasil diaktifkan kembali.'
            });
        } catch (error) {
            console.error('Failed to toggle status', error);
            const text = stepUpActionErrorMessage(error, 'Gagal mengubah status akun tim');
            if (text) setFeedback({ type: 'error', text });
        }
    };

    const handleResetTwoFactor = (member: TeamMember) => {
        if (!isOwner) return;
        setConfirmAction({ type: 'reset-2fa', member });
    };

    const executeResetTwoFactor = async (member: TeamMember) => {
        try {
            await stepUp.run('team.reset_2fa', (config) =>
                apiV2.put(`/teams/${member._id}/reset-2fa`, {}, config as never),
            );
            fetchMembers();
            fetchAuditLogs();
            setConfirmAction(null);
            setFeedback({ type: 'success', text: '2FA anggota tim berhasil direset.' });
        } catch (error) {
            console.error('Failed to reset team member 2FA', error);
            const text = stepUpActionErrorMessage(error, 'Gagal reset 2FA anggota tim');
            if (text) setFeedback({ type: 'error', text });
        }
    };

    const handleDelete = (member: TeamMember) => {
        if (!canManageMember(member)) {
            setFeedback({ type: 'error', text: 'Anda tidak memiliki izin untuk mengarsipkan anggota tim ini.' });
            return;
        }
        setConfirmAction({ type: 'archive', member });
    };

    const executeDelete = async (member: TeamMember) => {
        try {
            await stepUp.run('team.manage_privileged', (config) =>
                apiV2.delete(`/teams/${member._id}`, config as never),
            );
            fetchMembers();
            fetchAuditLogs();
            setConfirmAction(null);
            setFeedback({
                type: 'success',
                text: 'Akun tim berhasil diarsipkan.'
            });
        } catch (error) {
            console.error('Failed to delete team member', error);
            const text = stepUpActionErrorMessage(error, 'Gagal mengarsipkan anggota tim');
            if (text) setFeedback({ type: 'error', text });
        }
    };

    const fetchLoginLogs = async (memberId: string, page: number = 1) => {
        try {
            setLogsLoading(true);
            const res = await apiV2
                .get(`/teams/${memberId}/login-logs?page=${page}&limit=20`);
            setLoginLogs(res.data.logs);
            setLogsPagination({
                currentPage: res.data.currentPage,
                totalPages: res.data.totalPages,
                totalLogs: res.data.totalLogs
            });
        } catch (error) {
            console.error('Failed to fetch login logs', error);
            const err = error as { response?: { data?: { message?: string } } };
            setFeedback({ type: 'error', text: err.response?.data?.message || 'Gagal memuat log login anggota tim' });
        } finally {
            setLogsLoading(false);
        }
    };

    const handleViewLogs = (member: TeamMember) => {
        if (!canViewMemberLogs(member)) return;
        setLogsMember(member);
        setShowLogsModal(true);
        fetchLoginLogs(member._id);
    };

    const fetchAllLoginLogs = async (page: number = 1) => {
        try {
            setAllLogsLoading(true);
            const res = await apiV2
                .get(`/teams/login-logs/all?page=${page}&limit=20`);
            setAllLoginLogs(res.data.logs);
            setAllLogsPagination({
                currentPage: res.data.currentPage,
                totalPages: res.data.totalPages,
                totalLogs: res.data.totalLogs
            });
        } catch (error) {
            console.error('Failed to fetch all login logs', error);
            const err = error as { response?: { data?: { message?: string } } };
            setFeedback({ type: 'error', text: err.response?.data?.message || 'Gagal memuat log login tim' });
        } finally {
            setAllLogsLoading(false);
        }
    };

    const handleViewAllLogs = () => {
        if (!canManageTeam) return;
        setShowAllLogsModal(true);
        fetchAllLoginLogs();
    };

    const openAddModal = () => {
        setEditingMember(null);
        setForm(defaultForm);
        setShowPassword(false);
        setFeedback(null);
        setShowModal(true);
    };

    const inputClass = "w-full rounded-lg border px-3 py-2 text-sm ui-field";
    const selectClass = "w-full rounded-lg border px-3 py-2 text-sm ui-field";
    const labelClass = "block text-sm font-medium ui-text mb-1";

    return (<>

        <div className="space-y-6">
            <div className="ui-panel-muted flex flex-wrap gap-2 rounded-xl border ui-border p-4">
                        <button
                            onClick={fetchMembers}
                            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border text-sm font-semibold ui-muted-action hover:border-[var(--ui-accent)]"
                        >
                            <RefreshCw className="w-4 h-4" />
                            Segarkan
                        </button>
                        {canManageTeam && (
                            <button
                                onClick={handleViewAllLogs}
                                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border text-sm font-semibold ui-muted-action hover:border-[var(--ui-accent)]"
                            >
                                <ShieldCheck className="w-4 h-4" />
                                Log Login
                            </button>
                        )}
                        {canManageTeam && (
                            <button
                                onClick={openAddModal}
                                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl ui-accent-solid text-sm font-semibold shadow-[0_12px_40px_rgba(0,0,0,0.18)] transition-colors"
                            >
                                <Plus className="w-4 h-4" />
                                Tambah Tim
                            </button>
                        )}
            </div>

            {feedback && (
                <div className={`rounded-xl border px-4 py-3 text-sm ${
                    feedback.type === 'success'
                        ? 'ui-success-chip'
                        : 'ui-danger-chip'
                }`}>
                    {feedback.text}
                </div>
            )}

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <div className="ui-panel-muted rounded-xl border ui-border p-5">
                    <div className="text-xs uppercase tracking-[0.18em] ui-text-muted">Total Tim</div>
                    <div className="mt-2 text-3xl font-black ui-text">{summary.total}</div>
                    <p className="mt-1 text-sm ui-text-muted">{summary.owner} owner, {summary.admin} admin, {summary.cs} CS</p>
                </div>
                <div className="ui-panel-muted rounded-xl border ui-border p-5">
                    <div className="text-xs uppercase tracking-[0.18em] ui-success-text">Aktif</div>
                    <div className="mt-2 text-3xl font-black ui-success-text">{summary.active}</div>
                    <p className="mt-1 text-sm ui-text-muted">Akun tim yang bisa login.</p>
                </div>
                <div className="ui-panel-muted rounded-xl border ui-border p-5">
                    <div className="text-xs uppercase tracking-[0.18em] ui-warning-text">Nonaktif</div>
                    <div className="mt-2 text-3xl font-black ui-warning-text">{summary.inactive}</div>
                    <p className="mt-1 text-sm ui-text-muted">Tetap disimpan untuk histori audit.</p>
                </div>
                <div className="ui-panel-muted rounded-xl border ui-border p-5">
                    <div className="text-xs uppercase tracking-[0.18em] ui-text-muted">Akses Anda</div>
                    <div className="mt-2 text-2xl font-black ui-text">{canManageTeam ? 'Manage Team' : 'View Only'}</div>
                    <p className="mt-1 text-sm ui-text-muted">{isOwner ? 'Owner penuh' : 'Scope mengikuti permission aktif Anda.'}</p>
                </div>
            </div>

            <div className="ui-panel-muted rounded-xl border ui-border p-4">
                <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ui-text-muted" />
                    <input
                        type="text"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Cari nama, email, atau role anggota tim..."
                        className="w-full rounded-xl border pl-10 pr-4 py-2.5 text-sm ui-field"
                    />
                </div>
            </div>

            <div className="ui-panel-muted rounded-xl border ui-border overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="min-w-full">
                        <thead>
                            <tr className="ui-panel ui-text-muted text-xs uppercase">
                                <th className="px-4 py-3 text-left font-semibold">#</th>
                                <th className="px-4 py-3 text-left font-semibold">Nama</th>
                                <th className="px-4 py-3 text-left font-semibold">Role</th>
                                <th className="px-4 py-3 text-left font-semibold">Status</th>
                                <th className="px-4 py-3 text-left font-semibold">Akses efektif</th>
                                {canManageTeam && <th className="px-4 py-3 text-left font-semibold">Aksi</th>}
                            </tr>
                        </thead>
                        <tbody className="divide-y ui-border">
                            {loading ? (
                                <tr>
                                    <td colSpan={canManageTeam ? 6 : 5} className="px-4 py-6 text-center ui-text-muted">Memuat...</td>
                                </tr>
                            ) : filteredMembers.length === 0 ? (
                                <tr>
                                    <td colSpan={canManageTeam ? 6 : 5} className="px-4 py-6 text-center ui-text-muted">Tidak ada anggota tim yang cocok.</td>
                                </tr>
                            ) : (
                                filteredMembers.map((member, idx) => (
                                    <tr key={member._id} className="hover:bg-[var(--ui-card-bg)]">
                                        <td className="px-4 py-3 text-sm font-semibold ui-text">#{idx + 1}</td>
                                        <td className="px-4 py-3 text-sm ui-text font-semibold">
                                            <div>{member.name}</div>
                                            <div className="text-xs ui-text-muted">{member.email}</div>
                                            <div className="text-[11px] ui-text-muted mt-1">
                                                Dibuat {new Date(member.createdAt).toLocaleDateString('id-ID')}
                                                {member.createdBy?.name ? ` • oleh ${member.createdBy.name}` : ''}
                                            </div>
                                        </td>
                                        <td className="px-4 py-3 text-sm">
                                            <span className={`px-2 py-1 rounded-full text-xs font-semibold ${
                                                member.role === 'owner'
                                                    ? 'ui-accent-chip'
                                                    : member.role === 'admin'
                                                        ? 'ui-accent-chip'
                                                        : 'ui-info-chip'
                                            }`}>
                                                {member.role === 'owner' ? 'Owner' : member.role === 'admin' ? 'Admin' : 'CS'}
                                            </span>
                                        </td>
                                        <td className="px-4 py-3 text-sm font-semibold">
                                            <span className={`px-2 py-1 rounded-full text-xs ${
                                                member.active ? 'ui-success-chip' : 'ui-danger-chip'
                                            }`}>
                                                {member.active ? 'Aktif' : 'Nonaktif'}
                                            </span>
                                            {member.twoFactorEnabled && (
                                                <span className="ml-2 inline-flex rounded-full px-2 py-1 text-xs font-semibold ui-info-chip">
                                                    2FA
                                                </span>
                                            )}
                                        </td>
                                        <td className="px-4 py-3 text-sm ui-text">
                                            <div className="flex min-w-[15rem] flex-col items-start gap-2">
                                                <span className={`text-xs font-semibold ${member.active ? 'ui-text' : 'ui-warning-text'}`}>
                                                    {accessSummaryLabelFor(member)}
                                                </span>
                                                <button
                                                    type="button"
                                                    onClick={() => setAccessMember({
                                                        name: member.name,
                                                        email: member.email,
                                                        role: member.role,
                                                        active: member.active,
                                                        permissions: member.permissions,
                                                        twoFactorEnabled: member.twoFactorEnabled,
                                                    })}
                                                    aria-label={`Lihat akses ${member.name}`}
                                                    className="ui-muted-action rounded-lg border px-2.5 py-1.5 text-xs font-semibold"
                                                >
                                                    Lihat akses
                                                </button>
                                            </div>
                                        </td>
                                        {canManageTeam && (
                                            <td className="px-4 py-3 text-sm ui-text">
                                                {!canManageMember(member) ? (
                                                    <span className="text-xs ui-text-muted">-</span>
                                                ) : (
                                                    <div className="flex items-center gap-2">
                                                        <button
                                                            onClick={() => handleEdit(member)}
                                                            className="ui-info-chip p-1.5 rounded"
                                                            title="Edit"
                                                        >
                                                            <Edit className="w-4 h-4" />
                                                        </button>
                                                        <button
                                                            onClick={() => handleViewLogs(member)}
                                                            disabled={!canViewMemberLogs(member)}
                                                            className="ui-accent-text hover:text-[var(--ui-accent-strong)] bg-[var(--ui-accent-soft)] p-1.5 rounded"
                                                            title="Log Login"
                                                        >
                                                            <History className="w-4 h-4" />
                                                        </button>
                                                        <button
                                                            onClick={() => handleToggleActive(member)}
                                                            className={`p-1.5 rounded ${member.active ? 'ui-warning-chip' : 'ui-success-chip'}`}
                                                            title={member.active ? 'Nonaktifkan' : 'Aktifkan'}
                                                        >
                                                            {member.active ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                                        </button>
                                                        {isOwner && member.twoFactorEnabled && (
                                                            <button
                                                                onClick={() => handleResetTwoFactor(member)}
                                                                className="ui-warning-action p-1.5 rounded"
                                                                title="Reset 2FA"
                                                            >
                                                                <ShieldX className="w-4 h-4" />
                                                            </button>
                                                        )}
                                                        <button
                                                            onClick={() => handleDelete(member)}
                                                            className="ui-danger-action p-1.5 rounded"
                                                            title="Arsipkan"
                                                        >
                                                            <Trash2 className="w-4 h-4" />
                                                        </button>
                                                    </div>
                                                )}
                                            </td>
                                        )}
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {canManageTeam && (
                <div className="ui-panel-muted rounded-xl border ui-border p-5">
                    <div className="flex items-center justify-between gap-3">
                        <div>
                            <h3 className="text-lg font-semibold ui-text">Audit Perubahan Tim</h3>
                            <p className="text-sm ui-text-muted mt-1">Jejak perubahan role, permission, status, dan arsip akun tim.</p>
                        </div>
                        <button
                            onClick={fetchAuditLogs}
                            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border text-sm ui-muted-action"
                        >
                            <RefreshCw className="w-4 h-4" />
                            Segarkan
                        </button>
                    </div>

                    <div className="mt-4 space-y-3">
                        {auditLoading ? (
                            <div className="text-sm ui-text-muted">Memuat audit log...</div>
                        ) : auditLogs.length === 0 ? (
                            <div className="text-sm ui-text-muted">Belum ada perubahan tim yang tercatat.</div>
                        ) : (
                            auditLogs.map((log) => (
                                <div key={log._id} className="rounded-xl border ui-border ui-panel p-4">
                                    <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
                                        <div>
                                            <div className="text-sm font-semibold ui-text">{log.summary}</div>
                                            <div className="mt-1 text-xs ui-text-muted">
                                                {log.actorName} ({log.actorEmail}) → {log.targetName} ({log.targetEmail})
                                            </div>
                                        </div>
                                        <div className="text-xs ui-text-muted">
                                            {new Date(log.createdAt).toLocaleString('id-ID')}
                                        </div>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            )}

            {/* Modal */}
            {showModal && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
                    <div className="ui-panel border ui-border rounded-xl shadow-xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto">
                        <div className="ui-card-gradient flex items-center justify-between p-4 border-b ui-border">
                            <h2 className="text-lg font-semibold ui-text">
                                {editingMember ? 'Edit Anggota Tim' : 'Tambah Anggota Tim'}
                            </h2>
                            <button onClick={closeTeamModal} className="ui-text-muted hover:text-[var(--ui-text)]">
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        <form onSubmit={handleSubmit} className="p-4 space-y-4">
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className={labelClass}>Nama</label>
                                    <input
                                        type="text"
                                        value={form.name}
                                        onChange={(e) => setForm({ ...form, name: e.target.value })}
                                        className={inputClass}
                                        placeholder="Nama lengkap"
                                        required
                                    />
                                </div>
                                <div>
                                    <label className={labelClass}>Email</label>
                                    <input
                                        type="email"
                                        value={form.email}
                                        onChange={(e) => setForm({ ...form, email: e.target.value })}
                                        className={inputClass}
                                        placeholder="email@example.com"
                                        required
                                    />
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className={labelClass}>
                                        Password {editingMember && <span className="ui-text-muted">(kosongkan jika tidak diubah)</span>}
                                    </label>
                                    <div className="relative">
                                        <input
                                            type={showPassword ? 'text' : 'password'}
                                            value={form.password}
                                            onChange={(e) => setForm({ ...form, password: e.target.value })}
                                            className={inputClass}
                                            placeholder="••••••••"
                                            required={!editingMember}
                                            minLength={6}
                                        />
                                        <button
                                            type="button"
                                            onClick={() => setShowPassword(!showPassword)}
                                            className="absolute right-3 top-1/2 -translate-y-1/2 ui-text-muted hover:text-[var(--ui-text)]"
                                        >
                                            {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                        </button>
                                    </div>
                                </div>
                                <div>
                                    <label className={labelClass}>Role</label>
                                    <select
                                        value={form.role}
                                        onChange={(e) => handleRoleChange(e.target.value as 'admin' | 'cs')}
                                        className={selectClass}
                                    >
                                        <option value="cs">CS (Customer Service)</option>
                                        {isOwner && <option value="admin">Admin</option>}
                                    </select>
                                    {!isOwner && (
                                        <p className="mt-1 text-xs ui-warning-text">Non-owner dengan `manageTeam` hanya bisa membuat atau mengelola akun CS.</p>
                                    )}
                                </div>
                            </div>

                            <div>
                                <label className={labelClass}>Permissions</label>
                                <div className="ui-panel-muted border ui-border rounded-lg p-4 space-y-4 max-h-64 overflow-y-auto">
                                    {permissionGroups.map((group) => (
                                        <div key={group.name}>
                                            <h4 className="text-sm font-semibold ui-accent-text mb-2">{group.name}</h4>
                                            <div className="grid grid-cols-2 gap-2">
                                                {group.permissions.map((perm) => (
                                                    <label key={perm.key} className="flex items-center gap-2 text-sm ui-text cursor-pointer hover:text-[var(--ui-accent-strong)]">
                                                        <input
                                                            type="checkbox"
                                                            checked={form.permissions[perm.key as TeamPermissionKey]}
                                                            onChange={() => handlePermissionChange(perm.key as TeamPermissionKey)}
                                                            disabled={!isOwner && !user?.permissions?.[perm.key as TeamPermissionKey]}
                                                            className="w-4 h-4 rounded border-[var(--ui-border)] bg-[var(--ui-card-bg)] text-[var(--ui-accent)] focus:ring-[var(--ui-accent)]"
                                                        />
                                                        {perm.label}
                                                    </label>
                                                ))}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            <TeamAccessPreview
                                role={form.role}
                                permissions={form.permissions}
                                provisional={!isOwner}
                            />

                            <div className="flex justify-end gap-3 pt-4">
                                <button
                                    type="button"
                                    onClick={closeTeamModal}
                                    className="px-4 py-2 border rounded-lg text-sm font-medium ui-muted-action"
                                >
                                    Batal
                                </button>
                                <button
                                    type="submit"
                                    className="px-4 py-2 ui-accent-solid rounded-lg text-sm font-medium"
                                >
                                    Simpan
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {accessMember && (
                <TeamAccessDialog
                    member={accessMember}
                    onClose={() => setAccessMember(null)}
                />
            )}

            {/* Login Logs Modal */}
            {showLogsModal && logsMember && (
                <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
                    <div className="ui-panel rounded-2xl w-full max-w-4xl max-h-[80vh] flex flex-col shadow-2xl border ui-border">
                        <div className="ui-card-gradient flex items-center justify-between p-6 border-b ui-border">
                            <div>
                                <h2 className="text-2xl font-bold ui-text">Log Login</h2>
                                <p className="text-sm ui-text-muted mt-1">{logsMember.name} ({logsMember.email})</p>
                            </div>
                            <button
                                onClick={() => setShowLogsModal(false)}
                                className="ui-text-muted hover:text-[var(--ui-text)] transition-colors"
                            >
                                <X className="w-6 h-6" />
                            </button>
                        </div>

                        <div className="flex-1 overflow-auto p-6">
                            {logsLoading ? (
                                <div className="text-center py-8 ui-text-muted">Memuat...</div>
                            ) : loginLogs.length === 0 ? (
                                <div className="text-center py-8 ui-text-muted">Belum ada log login.</div>
                            ) : (
                                <div className="overflow-x-auto">
                                    <table className="min-w-full">
                                        <thead>
                                            <tr className="text-left text-xs font-medium ui-text-muted uppercase">
                                                <th className="pb-3">Waktu</th>
                                                <th className="pb-3">Status</th>
                                                <th className="pb-3">IP Address</th>
                                                <th className="pb-3">User Agent</th>
                                                <th className="pb-3">Keterangan</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y ui-border">
                                            {loginLogs.map((log) => (
                                                <tr key={log._id} className="text-sm">
                                                    <td className="py-3 ui-text">
                                                        {new Date(log.createdAt).toLocaleString('id-ID')}
                                                    </td>
                                                    <td className="py-3">
                                                        <span className={`px-2 py-1 rounded-full text-xs font-semibold ${
                                                            log.status === 'success'
                                                                 ? 'ui-success-chip'
                                                                 : 'ui-danger-chip'
                                                        }`}>
                                                            {log.status === 'success' ? 'Sukses' : 'Gagal'}
                                                        </span>
                                                    </td>
                                                    <td className="py-3 ui-text-muted">{log.ip || '-'}</td>
                                                    <td className="py-3 ui-text-muted max-w-xs truncate">{log.userAgent || '-'}</td>
                                                    <td className="py-3 ui-text-muted">{log.failReason || '-'}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </div>

                        {logsPagination.totalPages > 1 && (
                            <div className="flex items-center justify-between p-4 border-t ui-border">
                                <span className="text-sm ui-text-muted">
                                    Halaman {logsPagination.currentPage} dari {logsPagination.totalPages} ({logsPagination.totalLogs} total)
                                </span>
                                <div className="flex gap-2">
                                    <button
                                        onClick={() => fetchLoginLogs(logsMember._id, logsPagination.currentPage - 1)}
                                        disabled={logsPagination.currentPage === 1}
                                        className="px-3 py-1 ui-muted-action border rounded text-sm disabled:opacity-50"
                                    >
                                        Prev
                                    </button>
                                    <button
                                        onClick={() => fetchLoginLogs(logsMember._id, logsPagination.currentPage + 1)}
                                        disabled={logsPagination.currentPage === logsPagination.totalPages}
                                        className="px-3 py-1 ui-muted-action border rounded text-sm disabled:opacity-50"
                                    >
                                        Next
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {confirmAction && (
                <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-[60] p-4">
                    <div className="ui-panel rounded-2xl w-full max-w-md shadow-2xl border ui-border p-6" role="dialog" aria-modal="true" aria-labelledby="team-confirm-title">
                        <h2 id="team-confirm-title" className="text-lg font-semibold ui-text">
                            {confirmAction.type === 'reset-2fa' ? 'Reset 2FA anggota tim?' : 'Arsipkan anggota tim?'}
                        </h2>
                        <p className="mt-2 text-sm ui-text-muted">
                            {confirmAction.type === 'reset-2fa'
                                ? `${confirmAction.member.name} akan bisa login tanpa OTP sampai mereka setup ulang authenticator. Semua sesi aktif akan dicabut.`
                                : `${confirmAction.member.name} akan dinonaktifkan tanpa menghapus histori audit dan login.`}
                        </p>
                        <div className="mt-4 rounded-xl border ui-border ui-panel-muted p-3 text-sm ui-text">
                            <div className="font-semibold">{confirmAction.member.name}</div>
                            <div className="ui-text-muted">{confirmAction.member.email} • {confirmAction.member.role.toUpperCase()}</div>
                        </div>
                        <div className="mt-6 flex justify-end gap-3">
                            <button
                                type="button"
                                onClick={() => setConfirmAction(null)}
                                className="rounded-xl border px-4 py-2.5 text-sm ui-muted-action"
                            >
                                Batal
                            </button>
                            <button
                                type="button"
                                onClick={() => confirmAction.type === 'reset-2fa'
                                    ? void executeResetTwoFactor(confirmAction.member)
                                    : void executeDelete(confirmAction.member)}
                                className={`rounded-xl border px-4 py-2.5 text-sm font-semibold ${confirmAction.type === 'reset-2fa' ? 'ui-warning-action' : 'ui-danger-action'}`}
                            >
                                {confirmAction.type === 'reset-2fa' ? 'Reset 2FA' : 'Arsipkan'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* All Login Logs Modal */}
            {showAllLogsModal && (
                <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
                    <div className="ui-panel rounded-2xl w-full max-w-5xl max-h-[80vh] flex flex-col shadow-2xl border ui-border">
                        <div className="ui-card-gradient flex items-center justify-between p-6 border-b ui-border">
                            <div>
                                <h2 className="text-2xl font-bold ui-text">Log Login Tim</h2>
                                <p className="text-sm ui-text-muted mt-1">Semua aktivitas login admin dan CS</p>
                            </div>
                            <button
                                onClick={() => setShowAllLogsModal(false)}
                                className="ui-text-muted hover:text-[var(--ui-text)] transition-colors"
                            >
                                <X className="w-6 h-6" />
                            </button>
                        </div>

                        <div className="flex-1 overflow-auto p-6">
                            {allLogsLoading ? (
                                <div className="text-center py-8 ui-text-muted">Memuat...</div>
                            ) : allLoginLogs.length === 0 ? (
                                <div className="text-center py-8 ui-text-muted">Belum ada log login.</div>
                            ) : (
                                <div className="overflow-x-auto">
                                    <table className="min-w-full">
                                        <thead>
                                            <tr className="text-left text-xs font-medium ui-text-muted uppercase">
                                                <th className="pb-3">Waktu</th>
                                                <th className="pb-3">Email</th>
                                                <th className="pb-3">Role</th>
                                                <th className="pb-3">Status</th>
                                                <th className="pb-3">IP Address</th>
                                                <th className="pb-3">Keterangan</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y ui-border">
                                            {allLoginLogs.map((log) => (
                                                <tr key={log._id} className="text-sm">
                                                    <td className="py-3 ui-text whitespace-nowrap">
                                                        {new Date(log.createdAt).toLocaleString('id-ID')}
                                                    </td>
                                                    <td className="py-3 ui-text font-medium">{log.email}</td>
                                                    <td className="py-3">
                                                        <span className={`px-2 py-1 rounded-full text-xs font-semibold ${
                                                            log.role === 'owner'
                                                                ? 'ui-accent-chip'
                                                                : log.role === 'admin'
                                                                    ? 'ui-accent-chip'
                                                                    : 'ui-info-chip'
                                                        }`}>
                                                            {log.role === 'owner' ? 'Owner' : log.role === 'admin' ? 'Admin' : 'CS'}
                                                        </span>
                                                    </td>
                                                    <td className="py-3">
                                                        <span className={`px-2 py-1 rounded-full text-xs font-semibold ${
                                                            log.status === 'success'
                                                                 ? 'ui-success-chip'
                                                                 : 'ui-danger-chip'
                                                        }`}>
                                                            {log.status === 'success' ? 'Sukses' : 'Gagal'}
                                                        </span>
                                                    </td>
                                                    <td className="py-3 ui-text-muted">{log.ip || '-'}</td>
                                                    <td className="py-3 ui-text-muted">{log.failReason || '-'}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </div>

                        {allLogsPagination.totalPages > 1 && (
                            <div className="flex items-center justify-between p-4 border-t ui-border">
                                <span className="text-sm ui-text-muted">
                                    Halaman {allLogsPagination.currentPage} dari {allLogsPagination.totalPages} ({allLogsPagination.totalLogs} total)
                                </span>
                                <div className="flex gap-2">
                                    <button
                                        onClick={() => fetchAllLoginLogs(allLogsPagination.currentPage - 1)}
                                        disabled={allLogsPagination.currentPage === 1}
                                        className="px-3 py-1 ui-muted-action border rounded text-sm disabled:opacity-50"
                                    >
                                        Prev
                                    </button>
                                    <button
                                        onClick={() => fetchAllLoginLogs(allLogsPagination.currentPage + 1)}
                                        disabled={allLogsPagination.currentPage === allLogsPagination.totalPages}
                                        className="px-3 py-1 ui-muted-action border rounded text-sm disabled:opacity-50"
                                    >
                                        Next
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
            {stepUp.dialog}
        </>
    );
}
