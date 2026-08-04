import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Activity, AlertCircle, CalendarClock, Download, Eye, Filter, Monitor, Search, ShieldCheck, UserRound, X } from 'lucide-react';
import { apiV2 } from '../../api';
import { useStepUpOrchestration } from '../../auth/useStepUpOrchestration';
import { stepUpActionErrorMessage } from '../../auth/withStepUp';
import { useAuthStore } from '../../store/useAuthStore';

type AuditAction = 'create' | 'update' | 'delete' | 'execute';

interface AuditLogItem {
    _id: string;
    actorName: string;
    actorEmail: string;
    actorRole: 'owner' | 'admin' | 'cs' | 'member';
    action: AuditAction;
    resource: string;
    method: string;
    path: string;
    statusCode?: number;
    ip?: string;
    userAgent?: string;
    summary: string;
    metadata?: {
        params?: Record<string, unknown>;
        body?: Record<string, unknown>;
    };
    createdAt: string;
}

interface AuditLogsResponse {
    items: AuditLogItem[];
    resources: string[];
    pagination: {
        page: number;
        limit: number;
        total: number;
        totalPages: number;
    };
}

const actionLabels: Record<AuditAction, string> = {
    create: 'Buat',
    update: 'Ubah',
    delete: 'Hapus',
    execute: 'Eksekusi'
};

const actionClasses: Record<AuditAction, string> = {
    create: 'ui-success-chip',
    update: 'ui-info-chip',
    delete: 'ui-danger-chip',
    execute: 'ui-warning-chip'
};

const formatDateTime = (value: string | null | undefined) => {
    if (!value) {
        return '-';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return '-';
    }
    return new Intl.DateTimeFormat('id-ID', {
        dateStyle: 'medium',
        timeStyle: 'short'
    }).format(date);
};

const stringifyMetadata = (value: unknown) => {
    if (!value) {
        return '-';
    }

    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return '-';
    }
};

export default function AuditLogs() {
    const stepUp = useStepUpOrchestration();
    const { hasPermission, isOwner } = useAuthStore();
    const [searchParams, setSearchParams] = useSearchParams();
    const canExportAuditLogs = isOwner || hasPermission('manageTeam');
    const [items, setItems] = useState<AuditLogItem[]>([]);
    const [resources, setResources] = useState<string[]>([]);
    const [search, setSearch] = useState(searchParams.get('q') || '');
    const [action, setAction] = useState(searchParams.get('action') || '');
    const [resource, setResource] = useState(searchParams.get('resource') || '');
    const [startDate, setStartDate] = useState(searchParams.get('startDate') || '');
    const [endDate, setEndDate] = useState(searchParams.get('endDate') || '');
    const [page, setPage] = useState(Math.max(1, Number(searchParams.get('page')) || 1));
    const [totalPages, setTotalPages] = useState(1);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [exporting, setExporting] = useState(false);
    const [selectedLog, setSelectedLog] = useState<AuditLogItem | null>(null);
    const latestRequestId = useRef(0);

    const applyAuditResponse = (payload: AuditLogsResponse) => {
        setItems(payload.items || []);
        setResources(payload.resources || []);
        setTotalPages(payload.pagination?.totalPages || 1);
    };

    const requestParams = (overrides: Partial<{ page: number; search: string; action: string; resource: string; startDate: string; endDate: string }> = {}) => ({
        page: overrides.page ?? page,
        limit: 25,
        search: (overrides.search ?? search).trim() || undefined,
        action: (overrides.action ?? action) || undefined,
        resource: (overrides.resource ?? resource) || undefined,
        startDate: (overrides.startDate ?? startDate) || undefined,
        endDate: (overrides.endDate ?? endDate) || undefined
    });

    const hasInvalidDateRange = () => Boolean(startDate && endDate && startDate > endDate);

    const fetchLogs = useCallback(async (overrides: Partial<{ page: number; search: string; action: string; resource: string; startDate: string; endDate: string }> = {}) => {
        if (hasInvalidDateRange()) {
            setError('Tanggal mulai tidak boleh lebih besar dari tanggal akhir.');
            return;
        }
        const requestId = latestRequestId.current + 1;
        latestRequestId.current = requestId;
        setLoading(true);
        setError('');

        try {
            const response = await apiV2.get<AuditLogsResponse>('/audit-logs', { params: requestParams(overrides) });
            if (requestId !== latestRequestId.current) return;
            applyAuditResponse(response.data);
        } catch (err: any) {
            if (requestId !== latestRequestId.current) return;
            setError(err.response?.data?.message || 'Gagal memuat audit logs');
        } finally {
            if (requestId === latestRequestId.current) {
                setLoading(false);
            }
        }
    }, [page, search, action, resource, startDate, endDate]);

    useEffect(() => {
        fetchLogs();
    }, [fetchLogs]);

    useEffect(() => {
        const next = new URLSearchParams();
        if (search.trim()) next.set('q', search.trim());
        if (action) next.set('action', action);
        if (resource) next.set('resource', resource);
        if (startDate) next.set('startDate', startDate);
        if (endDate) next.set('endDate', endDate);
        if (page > 1) next.set('page', String(page));
        setSearchParams(next, { replace: true });
    }, [action, endDate, page, resource, search, setSearchParams, startDate]);

    useEffect(() => {
        const handler = () => fetchLogs();
        window.addEventListener('admin:refresh-current-page', handler);
        return () => window.removeEventListener('admin:refresh-current-page', handler);
    }, [fetchLogs]);

    const handleSearchSubmit = (event: React.FormEvent) => {
        event.preventDefault();
        setPage(1);
        fetchLogs({ page: 1 });
    };

    const resetFilters = () => {
        setSearch('');
        setAction('');
        setResource('');
        setStartDate('');
        setEndDate('');
        setPage(1);
        fetchLogs({ page: 1, search: '', action: '', resource: '', startDate: '', endDate: '' });
    };

    const readBlobErrorMessage = async (error: any) => {
        const data = error?.response?.data;
        if (data instanceof Blob && data.type.includes('application/json')) {
            try {
                const payload = JSON.parse(await data.text());
                return typeof payload?.message === 'string' ? payload.message : '';
            } catch {
                return '';
            }
        }
        return typeof error?.response?.data?.message === 'string' ? error.response.data.message : '';
    };

    const handleExport = async () => {
        if (!canExportAuditLogs) {
            setError('Export CSV membutuhkan izin Kelola Tim.');
            return;
        }
        if (hasInvalidDateRange()) {
            setError('Tanggal mulai tidak boleh lebih besar dari tanggal akhir.');
            return;
        }
        setExporting(true);
        setError('');

        try {
            const exportConfig = {
                params: {
                    search: search.trim() || undefined,
                    action: action || undefined,
                    resource: resource || undefined,
                    startDate: startDate || undefined,
                    endDate: endDate || undefined
                },
                responseType: 'blob'
            } as const;
            const response = await stepUp.run('exports.sensitive', (config) =>
                apiV2.get('/audit-logs/export', { ...exportConfig, ...config } as never),
            );

            const disposition = response.headers['content-disposition'] || '';
            const filenameMatch = /filename="?([^";]+)"?/i.exec(disposition);
            const filename = filenameMatch?.[1] || `admin-audit-logs-${new Date().toISOString().slice(0, 10)}.csv`;
            const url = window.URL.createObjectURL(new Blob([response.data]));
            const link = document.createElement('a');
            link.href = url;
            link.setAttribute('download', filename);
            document.body.appendChild(link);
            link.click();
            link.remove();
            window.setTimeout(() => window.URL.revokeObjectURL(url), 0);
        } catch (err: any) {
            const mapped = stepUpActionErrorMessage(err, '');
            if (mapped === null) {
                // cancelled
            } else if (mapped) {
                setError(mapped);
            } else {
                const message = await readBlobErrorMessage(err);
                setError(message || 'Gagal export audit logs. Pastikan akun memiliki izin kelola tim dan filter tanggal valid.');
            }
        } finally {
            setExporting(false);
        }
    };

    return (<>

        <div className="space-y-6">
            <section className="ui-panel-muted flex flex-wrap gap-2 rounded-2xl border ui-border p-4">
                <button
                    onClick={handleExport}
                    disabled={exporting || !canExportAuditLogs}
                    title={!canExportAuditLogs ? 'Export membutuhkan izin Kelola Tim' : undefined}
                    className="ui-accent-solid inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-60"
                >
                    <Download className={`h-4 w-4 ${exporting ? 'animate-pulse' : ''}`} />
                    {exporting ? 'Mengekspor...' : 'Export CSV'}
                </button>
            </section>

            <section className="ui-panel rounded-[24px] border p-4 sm:p-5">
                <form onSubmit={handleSearchSubmit} className="grid gap-3 xl:grid-cols-[1fr_170px_190px_170px_170px_auto]">
                    <div className="relative">
                        <Search className="ui-text-muted absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" />
                        <input
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                            placeholder="Cari actor, email, path, IP..."
                            className="ui-field w-full rounded-2xl border py-3 pl-10 pr-4 text-sm"
                        />
                    </div>
                    <select
                        value={action}
                        onChange={(event) => {
                            setAction(event.target.value);
                            setPage(1);
                        }}
                        className="ui-field rounded-2xl border px-4 py-3 text-sm"
                    >
                        <option value="">Semua aksi</option>
                        {Object.entries(actionLabels).map(([value, label]) => (
                            <option key={value} value={value}>{label}</option>
                        ))}
                    </select>
                    <select
                        value={resource}
                        onChange={(event) => {
                            setResource(event.target.value);
                            setPage(1);
                        }}
                        className="ui-field rounded-2xl border px-4 py-3 text-sm"
                    >
                        <option value="">Semua resource</option>
                        {resources.map((item) => (
                            <option key={item} value={item}>{item}</option>
                        ))}
                    </select>
                    <input
                        type="date"
                        value={startDate}
                        onChange={(event) => {
                            setStartDate(event.target.value);
                            setPage(1);
                        }}
                        className="ui-field rounded-2xl border px-4 py-3 text-sm"
                    />
                    <input
                        type="date"
                        value={endDate}
                        onChange={(event) => {
                            setEndDate(event.target.value);
                            setPage(1);
                        }}
                        className="ui-field rounded-2xl border px-4 py-3 text-sm"
                    />
                    <div className="flex gap-2">
                        <button type="submit" className="ui-accent-solid inline-flex flex-1 items-center justify-center gap-2 rounded-2xl px-4 py-3 text-sm font-bold">
                            <Filter className="h-4 w-4" /> Filter
                        </button>
                        <button type="button" onClick={resetFilters} className="ui-muted-action rounded-2xl px-4 py-3 text-sm font-bold">
                            Reset
                        </button>
                    </div>
                </form>
            </section>

            <div className="ui-warning-chip rounded-2xl border px-4 py-3 text-sm font-semibold">
                Export CSV dibatasi maksimal 5000 baris. Persempit filter tanggal atau resource untuk export yang lengkap.
            </div>

            {error && (
                <div className="ui-danger-chip flex items-center gap-2 rounded-2xl border px-4 py-3 text-sm font-semibold">
                    <AlertCircle className="h-4 w-4" /> {error}
                </div>
            )}

            <section className="ui-panel overflow-hidden rounded-[24px] border">
                <div className="ui-panel-muted ui-border flex items-center justify-between border-b px-5 py-4">
                    <div>
                        <h2 className="ui-text text-lg font-black">Aktivitas Audit</h2>
                        <p className="ui-text-muted text-sm">Halaman {page} dari {totalPages}</p>
                    </div>
                    <Activity className="ui-accent-text h-5 w-5" />
                </div>

                {loading ? (
                    <div className="space-y-3 p-5">
                        {Array.from({ length: 5 }).map((_, index) => (
                            <div key={index} className="ui-panel-muted h-24 animate-pulse rounded-2xl" />
                        ))}
                    </div>
                ) : items.length === 0 ? (
                    <div className="flex flex-col items-center justify-center px-5 py-16 text-center">
                        <ShieldCheck className="ui-text-muted h-12 w-12" />
                        <p className="ui-text mt-4 text-lg font-black">Belum ada audit log</p>
                        <p className="ui-text-muted mt-1 text-sm">Aktivitas admin yang mengubah data akan muncul di sini.</p>
                    </div>
                ) : (
                    <div className="divide-y ui-border">
                        {items.map((item) => (
                            <article key={item._id} className="grid gap-4 p-5 lg:grid-cols-[220px_1fr]">
                                <div className="space-y-3">
                                    <span className={`inline-flex rounded-full border px-3 py-1 text-xs font-black ${actionClasses[item.action]}`}>
                                        {actionLabels[item.action]}
                                    </span>
                                    <div className="space-y-1 text-sm">
                                        <p className="ui-text flex items-center gap-2 font-bold">
                                            <UserRound className="h-4 w-4" /> {item.actorName}
                                        </p>
                                        <p className="ui-text-muted break-all text-xs">{item.actorEmail}</p>
                                        <p className="ui-text-muted flex items-center gap-2 text-xs">
                                            <CalendarClock className="h-3.5 w-3.5" /> {formatDateTime(item.createdAt)}
                                        </p>
                                    </div>
                                </div>
                                <div className="min-w-0 space-y-3">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="ui-accent-chip rounded-full border px-3 py-1 text-xs font-bold">{item.resource}</span>
                                        <span className="ui-panel-muted ui-border rounded-full border px-3 py-1 text-xs font-bold">{item.method}</span>
                                        {item.statusCode && (
                                            <span className={`rounded-full border px-3 py-1 text-xs font-bold ${item.statusCode >= 400 ? 'ui-danger-chip' : 'ui-success-chip'}`}>
                                                HTTP {item.statusCode}
                                            </span>
                                        )}
                                    </div>
                                    <div>
                                        <p className="ui-text break-all text-sm font-black">{item.path}</p>
                                        <p className="ui-text-muted mt-1 flex items-center gap-2 break-all text-xs">
                                            <Monitor className="h-3.5 w-3.5 shrink-0" /> IP {item.ip || '-'}
                                        </p>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <button
                                            onClick={() => setSelectedLog(item)}
                                            className="ui-muted-action inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-black"
                                        >
                                            <Eye className="h-3.5 w-3.5" /> Detail Log
                                        </button>
                                        <span className="ui-text-muted text-xs">Ringkasan: {item.summary}</span>
                                    </div>
                                </div>
                            </article>
                        ))}
                    </div>
                )}

                <div className="ui-panel-muted ui-border flex flex-col gap-3 border-t px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <p className="ui-text-muted text-sm">Menampilkan maksimal 25 log per halaman</p>
                    <div className="flex gap-2">
                        <button
                            onClick={() => setPage((current) => Math.max(1, current - 1))}
                            disabled={page <= 1 || loading}
                            className="ui-muted-action rounded-xl px-4 py-2 text-sm font-bold disabled:opacity-50"
                        >
                            Sebelumnya
                        </button>
                        <button
                            onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                            disabled={page >= totalPages || loading}
                            className="ui-muted-action rounded-xl px-4 py-2 text-sm font-bold disabled:opacity-50"
                        >
                            Berikutnya
                        </button>
                    </div>
                </div>
            </section>

            {selectedLog && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
                    <div className="ui-panel max-h-[90vh] w-full max-w-4xl overflow-hidden rounded-[28px] border ui-border shadow-[0_35px_120px_rgba(0,0,0,0.45)]" role="dialog" aria-modal="true" aria-labelledby="audit-log-detail-title">
                        <div className="ui-panel-muted ui-border flex items-start justify-between gap-4 border-b p-5">
                            <div>
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className={`inline-flex rounded-full border px-3 py-1 text-xs font-black ${actionClasses[selectedLog.action]}`}>
                                        {actionLabels[selectedLog.action]}
                                    </span>
                                    <span className="ui-accent-chip rounded-full border px-3 py-1 text-xs font-black">{selectedLog.resource}</span>
                                    {selectedLog.statusCode && (
                                        <span className={`rounded-full border px-3 py-1 text-xs font-black ${selectedLog.statusCode >= 400 ? 'ui-danger-chip' : 'ui-success-chip'}`}>
                                            HTTP {selectedLog.statusCode}
                                        </span>
                                    )}
                                </div>
                                <h2 id="audit-log-detail-title" className="ui-text mt-3 text-xl font-black">Detail Log Audit</h2>
                                <p className="ui-text-muted mt-1 break-all text-sm">{selectedLog.summary}</p>
                            </div>
                            <button
                                onClick={() => setSelectedLog(null)}
                                className="ui-muted-action rounded-xl p-2"
                                aria-label="Tutup detail audit log"
                            >
                                <X className="h-5 w-5" />
                            </button>
                        </div>

                        <div className="max-h-[calc(90vh-120px)] overflow-y-auto p-5">
                            <div className="grid gap-4 md:grid-cols-2">
                                {[
                                    ['Aktor', selectedLog.actorName],
                                    ['Email', selectedLog.actorEmail],
                                    ['Peran', selectedLog.actorRole],
                                    ['Tanggal', formatDateTime(selectedLog.createdAt)],
                                    ['Method', selectedLog.method],
                                    ['Endpoint', selectedLog.path],
                                    ['IP', selectedLog.ip || '-'],
                                    ['User Agent', selectedLog.userAgent || '-']
                                ].map(([label, value]) => (
                                    <div key={label} className="ui-panel-muted rounded-2xl border ui-border p-4">
                                        <p className="ui-text-muted text-xs font-black uppercase tracking-[0.14em]">{label}</p>
                                        <p className="ui-text mt-2 break-all text-sm font-bold">{value}</p>
                                    </div>
                                ))}
                            </div>

                            <div className="mt-4 grid gap-4 lg:grid-cols-2">
                                <div className="ui-panel-muted rounded-2xl border ui-border p-4">
                                    <p className="ui-text-muted text-xs font-black uppercase tracking-[0.14em]">Params</p>
                                    <pre className="ui-text-muted mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-xl ui-panel px-3 py-2 text-xs leading-5">
                                        {stringifyMetadata(selectedLog.metadata?.params)}
                                    </pre>
                                </div>
                                <div className="ui-panel-muted rounded-2xl border ui-border p-4">
                                    <p className="ui-text-muted text-xs font-black uppercase tracking-[0.14em]">Body</p>
                                    <pre className="ui-text-muted mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-xl ui-panel px-3 py-2 text-xs leading-5">
                                        {stringifyMetadata(selectedLog.metadata?.body)}
                                    </pre>
                                </div>
                            </div>

                            <div className="ui-panel-muted mt-4 rounded-2xl border ui-border p-4">
                                <p className="ui-text-muted text-xs font-black uppercase tracking-[0.14em]">Metadata Mentah</p>
                                <pre className="ui-text-muted mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-xl ui-panel px-3 py-2 text-xs leading-5">
                                    {stringifyMetadata(selectedLog.metadata)}
                                </pre>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
            {stepUp.dialog}
        </>
    );
}
