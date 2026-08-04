import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, Bell, Check, CheckCircle2, Clock3, ExternalLink, EyeOff, ShieldAlert } from 'lucide-react';
import { apiV2 } from '../../api';

type NotificationSeverity = 'critical' | 'warning' | 'info';

interface AdminNotification {
    id: string;
    severity: NotificationSeverity;
    category: 'transactions' | 'deposits' | 'vendors' | 'callbacks';
    title: string;
    message: string;
    count: number;
    actionLabel: string;
    actionPath: string;
    fingerprint: string;
    readAt?: string | null;
    unread: boolean;
}

interface AdminNotificationsResponse {
    generatedAt: string;
    total: number;
    unread: number;
    critical: number;
    warning: number;
    info: number;
    notifications: AdminNotification[];
}

const severityValues: NotificationSeverity[] = ['critical', 'warning', 'info'];

const severityMeta: Record<NotificationSeverity, { label: string; className: string; icon: typeof AlertTriangle }> = {
    critical: { label: 'Critical', className: 'ui-danger-chip', icon: ShieldAlert },
    warning: { label: 'Warning', className: 'ui-warning-chip', icon: AlertTriangle },
    info: { label: 'Info', className: 'ui-info-chip', icon: Bell }
};

const categoryLabel: Record<AdminNotification['category'], string> = {
    transactions: 'Transaksi',
    deposits: 'Deposit',
    vendors: 'Vendor',
    callbacks: 'Callback'
};

const formatDateTime = (value?: string) => {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '-';

    return date.toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};

export default function AdminNotifications() {
    const [searchParams, setSearchParams] = useSearchParams();
    const severityParam = searchParams.get('severity');
    const initialSeverity = severityValues.includes(severityParam as NotificationSeverity)
        ? severityParam as NotificationSeverity
        : 'all';
    const [data, setData] = useState<AdminNotificationsResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [activeSeverity, setActiveSeverity] = useState<'all' | NotificationSeverity>(initialSeverity);
    const [updatingId, setUpdatingId] = useState<string | null>(null);
    const latestRequestId = useRef(0);
    const isMutating = Boolean(updatingId);

    const refreshSidebarBadges = () => {
        window.dispatchEvent(new CustomEvent('admin:sidebar-badges-refresh'));
    };

    const fetchNotifications = async () => {
        const requestId = latestRequestId.current + 1;
        latestRequestId.current = requestId;
        setLoading(true);
        setError('');

        try {
            const response = await apiV2.get<AdminNotificationsResponse>('/notifications/admin');
            if (requestId !== latestRequestId.current) return;
            setData(response.data);
        } catch (err: any) {
            if (requestId !== latestRequestId.current) return;
            setError(err.response?.data?.message || 'Gagal memuat notifikasi admin');
        } finally {
            if (requestId === latestRequestId.current) {
                setLoading(false);
            }
        }
    };

    useEffect(() => {
        fetchNotifications();
    }, []);

    useEffect(() => {
        const nextSeverity = severityValues.includes(severityParam as NotificationSeverity)
            ? severityParam as NotificationSeverity
            : 'all';
        setActiveSeverity(nextSeverity);
    }, [severityParam]);

    useEffect(() => {
        const handleLayoutRefresh = () => {
            void fetchNotifications();
        };

        window.addEventListener('admin:refresh-current-page', handleLayoutRefresh);
        return () => window.removeEventListener('admin:refresh-current-page', handleLayoutRefresh);
    });

    const handleSeverityChange = (severity: 'all' | NotificationSeverity) => {
        setActiveSeverity(severity);
        if (severity === 'all') {
            setSearchParams({});
        } else {
            setSearchParams({ severity });
        }
    };

    const updateNotification = async (notification: AdminNotification, action: 'read' | 'dismiss') => {
        setUpdatingId(`${notification.id}:${action}`);
        setError('');

        try {
            const payload = {
                fingerprint: notification.fingerprint
            };
            await apiV2
                .post(`/notifications/admin/${notification.id}/${action}`, payload);
            refreshSidebarBadges();
            await fetchNotifications();
        } catch (err: any) {
            setError(err.response?.data?.message || 'Gagal memperbarui notifikasi');
        } finally {
            setUpdatingId(null);
        }
    };

    const markAllRead = async () => {
        setUpdatingId('all:read');
        setError('');

        try {
            await apiV2
                .post('/notifications/admin/read-all');
            refreshSidebarBadges();
            await fetchNotifications();
        } catch (err: any) {
            setError(err.response?.data?.message || 'Gagal menandai semua notifikasi');
        } finally {
            setUpdatingId(null);
        }
    };

    const filteredNotifications = useMemo(() => {
        const notifications = data?.notifications || [];
        if (activeSeverity === 'all') return notifications;
        return notifications.filter((item) => item.severity === activeSeverity);
    }, [data, activeSeverity]);

    return (
        <div className="mx-auto w-full max-w-[1740px] min-w-0 space-y-5 pb-8 sm:space-y-6 sm:pb-10">
            <section className="ui-panel-muted flex flex-wrap gap-2 rounded-2xl border ui-border p-4">
                <button
                    onClick={markAllRead}
                    disabled={loading || isMutating || updatingId === 'all:read' || !data?.unread}
                    className="ui-accent-solid inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-black transition disabled:cursor-not-allowed disabled:opacity-60"
                >
                    <Check className="h-4 w-4" />
                    Tandai Dibaca
                </button>
            </section>

            {error && (
                <div className="ui-danger-chip flex flex-wrap items-center justify-between gap-3 rounded-2xl border px-4 py-3 text-sm font-semibold">
                    <span>{error}</span>
                    <button onClick={fetchNotifications} className="rounded-xl border px-3 py-1.5 text-xs font-black">Coba Lagi</button>
                </div>
            )}

            <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                {[
                    { label: 'Belum Dibaca', value: data?.unread || 0, tone: 'ui-accent-chip' },
                    { label: 'Total Alert', value: data?.total || 0, tone: 'ui-panel-muted ui-border' },
                    { label: 'Critical', value: data?.critical || 0, tone: 'ui-danger-chip' },
                    { label: 'Warning', value: data?.warning || 0, tone: 'ui-warning-chip' },
                    { label: 'Info', value: data?.info || 0, tone: 'ui-info-chip' }
                ].map((item) => (
                    <div key={item.label} className={`rounded-2xl border p-4 ${item.tone}`}>
                        <p className="text-xs font-black uppercase tracking-[0.16em] opacity-80">{item.label}</p>
                        <p className="mt-2 text-3xl font-black">{item.value}</p>
                    </div>
                ))}
            </section>

            <section className="ui-panel rounded-[24px] border p-4 sm:p-5">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                        <p className="ui-accent-text text-xs font-black uppercase tracking-[0.22em]">Alert Aktif</p>
                        <p className="ui-text-muted mt-1 text-sm">Generated: {formatDateTime(data?.generatedAt)}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        {[
                            { id: 'all' as const, label: 'Semua' },
                            { id: 'critical' as const, label: 'Critical' },
                            { id: 'warning' as const, label: 'Warning' },
                            { id: 'info' as const, label: 'Info' }
                        ].map((filter) => (
                            <button
                                key={filter.id}
                                onClick={() => handleSeverityChange(filter.id)}
                                className={`rounded-xl border px-3 py-2 text-xs font-black transition ${activeSeverity === filter.id ? 'ui-accent-chip' : 'ui-muted-action'}`}
                            >
                                {filter.label}
                            </button>
                        ))}
                    </div>
                </div>

                <div className="mt-5 space-y-3">
                    {loading && !data ? (
                        <div className="ui-panel-muted ui-border rounded-2xl border px-6 py-12 text-center">
                            <div className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-[color-mix(in_srgb,var(--ui-accent)_28%,transparent)] border-t-[var(--ui-accent)]" />
                            <p className="ui-text-muted mt-3 text-sm font-semibold">Memuat notifikasi...</p>
                        </div>
                    ) : filteredNotifications.length > 0 ? (
                        filteredNotifications.map((notification) => {
                            const meta = severityMeta[notification.severity];
                            const Icon = meta.icon;
                            return (
                                <article key={notification.id} className={`rounded-2xl border p-4 transition hover:border-[color-mix(in_srgb,var(--ui-accent)_38%,transparent)] ${notification.unread ? 'ui-panel ui-border shadow-[0_18px_50px_rgba(0,0,0,0.16)]' : 'ui-panel-muted ui-border opacity-80'}`}>
                                    <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                                        <div className="min-w-0">
                                            <div className="flex flex-wrap items-center gap-2">
                                                {notification.unread && (
                                                    <span className="ui-accent-chip rounded-full border px-2.5 py-1 text-[10px] font-black uppercase tracking-wide">
                                                        Belum dibaca
                                                    </span>
                                                )}
                                                <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] font-black uppercase tracking-wide ${meta.className}`}>
                                                    <Icon className="h-3.5 w-3.5" /> {meta.label}
                                                </span>
                                                <span className="ui-panel ui-border rounded-full border px-2.5 py-1 text-[10px] font-black uppercase tracking-wide ui-text-muted">
                                                    {categoryLabel[notification.category]}
                                                </span>
                                            </div>
                                            <h2 className="ui-text mt-3 text-lg font-black">{notification.title}</h2>
                                            <p className="ui-text-muted mt-1 text-sm leading-6">{notification.message}</p>
                                        </div>
                                        <div className="flex shrink-0 flex-col gap-2 sm:flex-row lg:flex-col">
                                            <div className="ui-panel ui-border rounded-xl border px-4 py-2 text-center">
                                                <p className="ui-text text-xl font-black">{notification.count}</p>
                                                <p className="ui-text-muted text-[10px] font-black uppercase tracking-[0.14em]">Jumlah</p>
                                            </div>
                                            <Link to={notification.actionPath} onClick={() => notification.unread && updateNotification(notification, 'read')} className="ui-accent-solid inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-xs font-black">
                                                {notification.actionLabel} <ExternalLink className="h-3.5 w-3.5" />
                                            </Link>
                                            {notification.unread && (
                                                <button
                                                    onClick={() => updateNotification(notification, 'read')}
                                                    disabled={isMutating}
                                                    className="ui-muted-action inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-xs font-black disabled:opacity-60"
                                                >
                                                    <Check className="h-3.5 w-3.5" /> Dibaca
                                                </button>
                                            )}
                                            <button
                                                onClick={() => updateNotification(notification, 'dismiss')}
                                                disabled={isMutating}
                                                className="ui-danger-action inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-xs font-black disabled:opacity-60"
                                            >
                                                <EyeOff className="h-3.5 w-3.5" /> Sembunyikan
                                            </button>
                                        </div>
                                    </div>
                                </article>
                            );
                        })
                    ) : (
                        <div className={`${data?.total ? 'ui-info-chip' : 'ui-success-chip'} rounded-2xl border px-6 py-12 text-center`}>
                            <CheckCircle2 className="mx-auto h-10 w-10" />
                            <p className="mt-3 text-lg font-black">
                                {data?.total && activeSeverity !== 'all' ? `Tidak ada alert ${severityMeta[activeSeverity].label}` : 'Tidak ada alert aktif'}
                            </p>
                            <p className="mt-1 text-sm opacity-80">
                                {data?.total && activeSeverity !== 'all'
                                    ? 'Masih ada alert pada filter lain. Gunakan tab Semua untuk melihat seluruh sinyal.'
                                    : 'Semua sinyal operasional saat ini normal.'}
                            </p>
                        </div>
                    )}
                </div>
            </section>

            <div className="ui-panel-muted ui-border flex items-center gap-2 rounded-2xl border px-4 py-3 text-xs ui-text-muted">
                <Clock3 className="h-4 w-4" />
                Notifikasi dihitung real-time dari data existing, dengan unread/dismiss tersimpan per admin. Alert yang berubah jumlah atau pesan akan muncul lagi sebagai notifikasi baru.
            </div>
        </div>
    );
}
