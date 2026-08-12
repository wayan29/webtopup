import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Activity, AlertCircle, CalendarClock, Download, Eye, Filter, Monitor, Search, ShieldCheck, UserRound } from 'lucide-react';
import { apiV2 } from '../../api';
import { useStepUpOrchestration } from '../../auth/useStepUpOrchestration';
import { stepUpActionErrorMessage } from '../../auth/withStepUp';
import AuditLogDetailDialog, {
    resolveAuditLogSource,
    type AuditLogItem,
} from '../../components/admin/AuditLogDetailDialog';
import {
    auditPageCorrection,
    auditPaginationRange,
    parseAuditLogSearchParams,
    serializeAuditLogQuery,
    validateAuditLogDraft,
    type AuditAction,
    type AuditLogAppliedQuery,
    type AuditLogFilterDraft,
} from '../../lib/auditLogQuery';
import { useAuthStore } from '../../store/useAuthStore';

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

type ResultState = 'initial-loading' | 'ready' | 'initial-error' | 'refreshing' | 'refresh-error';

const actionLabels: Record<AuditAction, string> = {
    create: 'Buat',
    update: 'Ubah',
    delete: 'Hapus',
    execute: 'Eksekusi',
};

const actionClasses: Record<AuditAction, string> = {
    create: 'ui-success-chip',
    update: 'ui-info-chip',
    delete: 'ui-danger-chip',
    execute: 'ui-warning-chip',
};

const emptyDraft: AuditLogFilterDraft = {
    search: '',
    action: '',
    resource: '',
    startDate: '',
    endDate: '',
};

const emptyApplied: AuditLogAppliedQuery = {
    ...emptyDraft,
    page: 1,
};

const formatDateTime = (value: string | null | undefined) => {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    return new Intl.DateTimeFormat('id-ID', {
        dateStyle: 'medium',
        timeStyle: 'short',
    }).format(date);
};

const hasAppliedFilters = (query: AuditLogAppliedQuery) =>
    Boolean(query.search || query.action || query.resource || query.startDate || query.endDate);

export default function AuditLogs() {
    const stepUp = useStepUpOrchestration();
    const { hasPermission, isOwner } = useAuthStore();
    const [searchParams, setSearchParams] = useSearchParams();
    const canExportAuditLogs = isOwner || hasPermission('manageTeam');

    const parsedQuery = useMemo(() => parseAuditLogSearchParams(searchParams), [searchParams]);
    const appliedQuery = parsedQuery.ok ? parsedQuery.value : emptyApplied;
    const appliedCanonical = parsedQuery.ok ? parsedQuery.canonicalQueryString : '';

    const [draft, setDraft] = useState<AuditLogFilterDraft>(() => (
        parsedQuery.ok
            ? {
                search: parsedQuery.value.search,
                action: parsedQuery.value.action,
                resource: parsedQuery.value.resource,
                startDate: parsedQuery.value.startDate,
                endDate: parsedQuery.value.endDate,
            }
            : emptyDraft
    ));
    const [items, setItems] = useState<AuditLogItem[]>([]);
    const [resources, setResources] = useState<string[]>([]);
    const [total, setTotal] = useState(0);
    const [totalPages, setTotalPages] = useState(1);
    const [limit, setLimit] = useState(25);
    const [resultState, setResultState] = useState<ResultState>('initial-loading');
    const [error, setError] = useState('');
    const [statusMessage, setStatusMessage] = useState('Memuat log audit…');
    const [exporting, setExporting] = useState(false);
    const [exportStatus, setExportStatus] = useState('');
    const [selectedLog, setSelectedLog] = useState<AuditLogItem | null>(null);
    const [detailTrigger, setDetailTrigger] = useState<HTMLElement | null>(null);
    const [jumpPage, setJumpPage] = useState('');
    const latestRequestId = useRef(0);
    const resultsHeadingRef = useRef<HTMLHeadingElement>(null);
    const loadedCanonicalRef = useRef<string | null>(null);

    const draftValidation = validateAuditLogDraft(draft);
    const range = auditPaginationRange(appliedQuery.page, limit, total);
    const filtersActive = hasAppliedFilters(appliedQuery);

    useEffect(() => {
        if (!parsedQuery.ok) return;
        setDraft({
            search: parsedQuery.value.search,
            action: parsedQuery.value.action,
            resource: parsedQuery.value.resource,
            startDate: parsedQuery.value.startDate,
            endDate: parsedQuery.value.endDate,
        });
    }, [appliedCanonical, parsedQuery]);

    const fetchLogs = useCallback(async (options: { background?: boolean } = {}) => {
        if (!parsedQuery.ok) {
            setResultState('initial-error');
            setError(parsedQuery.message);
            setStatusMessage('');
            setItems([]);
            return;
        }

        const requestId = latestRequestId.current + 1;
        latestRequestId.current = requestId;
        const sameQuery = loadedCanonicalRef.current === appliedCanonical;
        const background = options.background === true && sameQuery && items.length > 0;

        if (background) {
            setResultState('refreshing');
            setStatusMessage('Memperbarui log audit…');
        } else if (!sameQuery || items.length === 0) {
            setItems([]);
            setResultState('initial-loading');
            setStatusMessage('Memuat log audit…');
        } else {
            setResultState('refreshing');
            setStatusMessage('Memperbarui log audit…');
        }
        setError('');

        try {
            const response = await apiV2.get<AuditLogsResponse>('/audit-logs', {
                params: {
                    page: appliedQuery.page,
                    limit: 25,
                    search: appliedQuery.search || undefined,
                    action: appliedQuery.action || undefined,
                    resource: appliedQuery.resource || undefined,
                    startDate: appliedQuery.startDate || undefined,
                    endDate: appliedQuery.endDate || undefined,
                },
            });
            if (requestId !== latestRequestId.current) return;

            const payload = response.data;
            const nextTotal = payload.pagination?.total ?? 0;
            const nextTotalPages = payload.pagination?.totalPages ?? 0;
            const nextLimit = payload.pagination?.limit ?? 25;
            const correction = auditPageCorrection(appliedQuery.page, nextTotalPages, nextTotal);
            if (correction !== null) {
                const corrected = serializeAuditLogQuery({ ...appliedQuery, page: correction });
                setSearchParams(corrected, { replace: true });
                return;
            }

            setItems(payload.items || []);
            setResources(payload.resources || []);
            setTotal(nextTotal);
            setTotalPages(nextTotalPages || 1);
            setLimit(nextLimit);
            loadedCanonicalRef.current = appliedCanonical;
            setResultState('ready');
            const nextRange = auditPaginationRange(appliedQuery.page, nextLimit, nextTotal);
            setStatusMessage(
                nextTotal === 0
                    ? (filtersActive ? 'Tidak ada log yang cocok dengan filter.' : 'Belum ada aktivitas audit.')
                    : `Menampilkan ${nextRange.start}–${nextRange.end} dari ${nextTotal} log. Halaman ${appliedQuery.page} dari ${nextTotalPages || 1}.`,
            );
        } catch (err: any) {
            if (requestId !== latestRequestId.current) return;
            const message = err.response?.data?.message || 'Gagal memuat audit logs';
            setError(message);
            if (sameQuery && items.length > 0) {
                setResultState('refresh-error');
                setStatusMessage('Pembaruan gagal. Data yang ditampilkan adalah hasil sebelumnya.');
            } else {
                setItems([]);
                setResultState('initial-error');
                setStatusMessage('');
            }
        }
    }, [appliedCanonical, appliedQuery, filtersActive, items.length, parsedQuery, setSearchParams]);

    useEffect(() => {
        void fetchLogs();
    }, [appliedCanonical]); // eslint-disable-line react-hooks/exhaustive-deps -- fetch only when applied URL changes

    useEffect(() => {
        const handler = () => {
            void fetchLogs({ background: true });
        };
        window.addEventListener('admin:refresh-current-page', handler);
        return () => window.removeEventListener('admin:refresh-current-page', handler);
    }, [fetchLogs]);

    const applyDraftToUrl = (nextDraft: AuditLogFilterDraft, page = 1, history: 'push' | 'replace' = 'push') => {
        const validated = validateAuditLogDraft(nextDraft);
        if (!validated.ok) {
            setError(validated.message);
            setResultState('initial-error');
            return;
        }
        const params = serializeAuditLogQuery({ ...validated.value, page });
        setSearchParams(params, { replace: history === 'replace' });
    };

    const handleSearchSubmit = (event: FormEvent) => {
        event.preventDefault();
        applyDraftToUrl(draft, 1, 'push');
    };

    const resetFilters = () => {
        setDraft(emptyDraft);
        setSearchParams(new URLSearchParams(), { replace: false });
    };

    const goToPage = (page: number, history: 'push' | 'replace' = 'push') => {
        if (!parsedQuery.ok) return;
        const params = serializeAuditLogQuery({ ...appliedQuery, page });
        setSearchParams(params, { replace: history === 'replace' });
        window.setTimeout(() => resultsHeadingRef.current?.focus(), 0);
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
            setError('Export CSV membutuhkan izin Kelola Tim dan verifikasi keamanan.');
            return;
        }
        if (!parsedQuery.ok) {
            setError(parsedQuery.message);
            return;
        }
        setExporting(true);
        setError('');
        setExportStatus('Menyiapkan export CSV…');

        try {
            const exportConfig = {
                params: {
                    search: appliedQuery.search || undefined,
                    action: appliedQuery.action || undefined,
                    resource: appliedQuery.resource || undefined,
                    startDate: appliedQuery.startDate || undefined,
                    endDate: appliedQuery.endDate || undefined,
                },
                responseType: 'blob',
            } as const;
            const response = await stepUp.run('exports.sensitive', (config) =>
                apiV2.get('/audit-logs/export', { ...exportConfig, ...config } as never),
            );

            const disposition = response.headers['content-disposition'] || '';
            const filenameMatch = /filename="?([^";]+)"?/i.exec(disposition);
            const filename = filenameMatch?.[1] || `admin-audit-logs-${new Date().toISOString().slice(0, 10)}.csv`;
            const truncated = response.headers['x-export-truncated'] === 'true';
            const url = window.URL.createObjectURL(new Blob([response.data]));
            const link = document.createElement('a');
            link.href = url;
            link.setAttribute('download', filename);
            document.body.appendChild(link);
            link.click();
            link.remove();
            window.setTimeout(() => window.URL.revokeObjectURL(url), 0);
            setExportStatus(
                truncated
                    ? 'Export dibatasi hingga 5.000 baris. Persempit filter untuk export lengkap.'
                    : 'Export CSV berhasil diunduh.',
            );
        } catch (err: any) {
            const mapped = stepUpActionErrorMessage(err, '');
            if (mapped === null) {
                setExportStatus('Export dibatalkan.');
            } else if (mapped) {
                setError(mapped);
                setExportStatus('');
            } else {
                const message = await readBlobErrorMessage(err);
                setError(message || 'Gagal export audit logs. Pastikan akun memiliki izin kelola tim dan filter tanggal valid.');
                setExportStatus('');
            }
        } finally {
            setExporting(false);
        }
    };

    const loading = resultState === 'initial-loading' || resultState === 'refreshing';
    const showInitialError = resultState === 'initial-error';
    const showRefreshError = resultState === 'refresh-error';
    const fieldError = !draftValidation.ok ? draftValidation : (!parsedQuery.ok ? parsedQuery : null);

    return (
        <>
            <div className="space-y-6">
                <section className="ui-panel-muted rounded-2xl border ui-border p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                            <p className="ui-text text-sm font-black">Investigasi audit</p>
                            <p className="ui-text-muted mt-1 text-sm">Aktivitas dan perubahan panel admin</p>
                        </div>
                        <div className="space-y-2">
                            <button
                                onClick={handleExport}
                                disabled={exporting || !canExportAuditLogs || !parsedQuery.ok}
                                className="ui-accent-solid inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-60"
                            >
                                <Download className={`h-4 w-4 ${exporting ? 'animate-pulse' : ''}`} />
                                {exporting ? 'Mengekspor...' : 'Export CSV'}
                            </button>
                            {!canExportAuditLogs && (
                                <p className="max-w-xs text-xs font-semibold ui-text-muted">
                                    Export CSV membutuhkan izin Kelola Tim dan verifikasi keamanan.
                                </p>
                            )}
                        </div>
                    </div>
                </section>

                <section className="ui-panel rounded-[24px] border p-4 sm:p-5">
                    <form onSubmit={handleSearchSubmit} className="grid gap-3 xl:grid-cols-[1.4fr_repeat(4,minmax(0,1fr))_auto]">
                        <label className="space-y-1 text-xs font-bold ui-text-muted">
                            Cari aktivitas
                            <div className="relative">
                                <Search className="ui-text-muted absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" aria-hidden="true" />
                                <input
                                    value={draft.search}
                                    onChange={(event) => setDraft((current) => ({ ...current, search: event.target.value }))}
                                    placeholder="Contoh: actor, endpoint, IP"
                                    className="ui-field w-full rounded-2xl border py-3 pl-10 pr-4 text-sm"
                                    aria-invalid={fieldError?.field === 'search' || undefined}
                                    aria-describedby={fieldError?.field === 'search' ? 'audit-filter-error' : undefined}
                                />
                            </div>
                        </label>
                        <label className="space-y-1 text-xs font-bold ui-text-muted">
                            Aksi
                            <select
                                value={draft.action}
                                onChange={(event) => setDraft((current) => ({ ...current, action: event.target.value as AuditAction | '' }))}
                                className="ui-field w-full rounded-2xl border px-4 py-3 text-sm"
                                aria-invalid={fieldError?.field === 'action' || undefined}
                            >
                                <option value="">Semua aksi</option>
                                {Object.entries(actionLabels).map(([value, label]) => (
                                    <option key={value} value={value}>{label}</option>
                                ))}
                            </select>
                        </label>
                        <label className="space-y-1 text-xs font-bold ui-text-muted">
                            Resource
                            <select
                                value={draft.resource}
                                onChange={(event) => setDraft((current) => ({ ...current, resource: event.target.value }))}
                                className="ui-field w-full rounded-2xl border px-4 py-3 text-sm"
                                aria-invalid={fieldError?.field === 'resource' || undefined}
                            >
                                <option value="">Semua resource</option>
                                {resources.map((item) => (
                                    <option key={item} value={item}>{item}</option>
                                ))}
                                {draft.resource && !resources.includes(draft.resource) && (
                                    <option value={draft.resource}>{draft.resource}</option>
                                )}
                            </select>
                        </label>
                        <label className="space-y-1 text-xs font-bold ui-text-muted">
                            Tanggal mulai
                            <input
                                type="date"
                                value={draft.startDate}
                                onChange={(event) => setDraft((current) => ({ ...current, startDate: event.target.value }))}
                                className="ui-field w-full rounded-2xl border px-4 py-3 text-sm"
                                aria-invalid={fieldError?.field === 'startDate' || undefined}
                                aria-describedby={fieldError?.field === 'startDate' ? 'audit-filter-error' : undefined}
                            />
                        </label>
                        <label className="space-y-1 text-xs font-bold ui-text-muted">
                            Tanggal akhir
                            <input
                                type="date"
                                value={draft.endDate}
                                onChange={(event) => setDraft((current) => ({ ...current, endDate: event.target.value }))}
                                className="ui-field w-full rounded-2xl border px-4 py-3 text-sm"
                                aria-invalid={fieldError?.field === 'endDate' || undefined}
                                aria-describedby={fieldError?.field === 'endDate' ? 'audit-filter-error' : undefined}
                            />
                        </label>
                        <div className="flex items-end gap-2">
                            <button type="submit" className="ui-accent-solid inline-flex flex-1 items-center justify-center gap-2 rounded-2xl px-4 py-3 text-sm font-bold">
                                <Filter className="h-4 w-4" /> Terapkan filter
                            </button>
                            <button type="button" onClick={resetFilters} className="ui-muted-action rounded-2xl px-4 py-3 text-sm font-bold">
                                Reset
                            </button>
                        </div>
                    </form>
                    {fieldError && !fieldError.ok && (
                        <p id="audit-filter-error" role="alert" className="ui-danger-chip mt-3 rounded-2xl border px-4 py-3 text-sm font-semibold">
                            {fieldError.message}
                        </p>
                    )}
                </section>

                {canExportAuditLogs && (
                    <div className="ui-warning-chip rounded-2xl border px-4 py-3 text-sm font-semibold">
                        Export CSV dibatasi maksimal 5000 baris. Persempit filter tanggal atau resource untuk export yang lengkap.
                    </div>
                )}

                {(error || showRefreshError) && (
                    <div role="alert" className="ui-danger-chip flex flex-wrap items-center gap-3 rounded-2xl border px-4 py-3 text-sm font-semibold">
                        <AlertCircle className="h-4 w-4" />
                        <span>{showRefreshError ? 'Pembaruan gagal. Data yang ditampilkan adalah hasil sebelumnya.' : error}</span>
                        <button type="button" onClick={() => void fetchLogs({ background: showRefreshError })} className="ui-muted-action rounded-xl px-3 py-1.5 text-xs font-bold">
                            Coba lagi
                        </button>
                    </div>
                )}

                <div role="status" aria-live="polite" className="sr-only">{statusMessage}</div>
                {exportStatus && (
                    <div role="status" aria-live="polite" className="ui-info-chip rounded-2xl border px-4 py-3 text-sm font-semibold">
                        {exportStatus}
                    </div>
                )}

                <section className="ui-panel overflow-hidden rounded-[24px] border" aria-busy={loading || undefined}>
                    <div className="ui-panel-muted ui-border flex items-center justify-between border-b px-5 py-4">
                        <div>
                            <h2 ref={resultsHeadingRef} tabIndex={-1} className="ui-text text-lg font-black outline-none">Aktivitas Audit</h2>
                            <p className="ui-text-muted text-sm">
                                {total > 0
                                    ? `${range.start}–${range.end} dari ${total} log · Halaman ${appliedQuery.page} dari ${totalPages}`
                                    : `Halaman ${appliedQuery.page} dari ${totalPages}`}
                            </p>
                        </div>
                        <Activity className="ui-accent-text h-5 w-5" />
                    </div>

                    {resultState === 'initial-loading' ? (
                        <div className="space-y-3 p-5" aria-hidden="true">
                            {Array.from({ length: 5 }).map((_, index) => (
                                <div key={index} className="ui-panel-muted h-24 animate-pulse rounded-2xl" />
                            ))}
                        </div>
                    ) : showInitialError ? (
                        <div className="flex flex-col items-center justify-center px-5 py-16 text-center">
                            <AlertCircle className="ui-text-muted h-12 w-12" />
                            <p className="ui-text mt-4 text-lg font-black">Gagal memuat log audit</p>
                            <button type="button" onClick={() => void fetchLogs()} className="ui-accent-solid mt-4 rounded-xl px-4 py-2 text-sm font-bold">
                                Coba lagi
                            </button>
                            <button type="button" onClick={resetFilters} className="ui-muted-action mt-2 rounded-xl px-4 py-2 text-sm font-bold">
                                Reset filter
                            </button>
                        </div>
                    ) : items.length === 0 ? (
                        <div className="flex flex-col items-center justify-center px-5 py-16 text-center">
                            <ShieldCheck className="ui-text-muted h-12 w-12" />
                            <p className="ui-text mt-4 text-lg font-black">
                                {filtersActive ? 'Tidak ada log yang cocok dengan filter' : 'Belum ada aktivitas audit'}
                            </p>
                            <p className="ui-text-muted mt-1 text-sm">
                                {filtersActive
                                    ? 'Sesuaikan filter atau reset untuk melihat seluruh jejak.'
                                    : 'Aktivitas admin yang mengubah data akan muncul di sini.'}
                            </p>
                            {filtersActive && (
                                <button type="button" onClick={resetFilters} className="ui-muted-action mt-4 rounded-xl px-4 py-2 text-sm font-bold">
                                    Reset filter
                                </button>
                            )}
                        </div>
                    ) : (
                        <div className="divide-y ui-border">
                            {items.map((item) => {
                                const source = resolveAuditLogSource(item.metadata);
                                return (
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
                                                <span className="ui-info-chip rounded-full border px-3 py-1 text-xs font-bold">{source}</span>
                                                <span className="ui-panel-muted ui-border rounded-full border px-3 py-1 text-xs font-bold">{item.method}</span>
                                                {item.statusCode !== undefined && (
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
                                                    onClick={(event) => {
                                                        setSelectedLog(item);
                                                        setDetailTrigger(event.currentTarget);
                                                    }}
                                                    className="ui-muted-action inline-flex min-h-11 items-center gap-2 rounded-xl px-3 py-2 text-xs font-black"
                                                >
                                                    <Eye className="h-3.5 w-3.5" /> Detail
                                                </button>
                                                <span className="ui-text-muted text-xs">Ringkasan: {item.summary}</span>
                                            </div>
                                        </div>
                                    </article>
                                );
                            })}
                        </div>
                    )}

                    <div className="ui-panel-muted ui-border flex flex-col gap-3 border-t px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                        <p className="ui-text-muted text-sm">
                            {total > 0 ? `${range.start}–${range.end} dari ${total} log` : 'Tidak ada log pada halaman ini'}
                        </p>
                        <nav aria-label="Pagination log audit" className="flex flex-wrap items-center gap-2">
                            <button
                                onClick={() => goToPage(Math.max(1, appliedQuery.page - 1))}
                                disabled={appliedQuery.page <= 1 || loading}
                                className="ui-muted-action min-h-11 rounded-xl px-4 py-2 text-sm font-bold disabled:opacity-50"
                            >
                                Sebelumnya
                            </button>
                            <button
                                onClick={() => goToPage(Math.min(totalPages, appliedQuery.page + 1))}
                                disabled={appliedQuery.page >= totalPages || loading}
                                className="ui-muted-action min-h-11 rounded-xl px-4 py-2 text-sm font-bold disabled:opacity-50"
                            >
                                Berikutnya
                            </button>
                            {totalPages > 10 && (
                                <form
                                    className="flex items-center gap-2"
                                    onSubmit={(event) => {
                                        event.preventDefault();
                                        const page = Number(jumpPage);
                                        if (!Number.isInteger(page) || page < 1 || page > totalPages) {
                                            setError('Nomor halaman tidak valid.');
                                            return;
                                        }
                                        goToPage(page);
                                        setJumpPage('');
                                    }}
                                >
                                    <label className="ui-text-muted text-xs font-bold">
                                        Ke halaman
                                        <input
                                            value={jumpPage}
                                            onChange={(event) => setJumpPage(event.target.value)}
                                            className="ui-field ml-2 w-20 rounded-xl border px-3 py-2 text-sm"
                                        />
                                    </label>
                                    <button type="submit" className="ui-muted-action min-h-11 rounded-xl px-3 py-2 text-xs font-bold">
                                        Buka
                                    </button>
                                </form>
                            )}
                        </nav>
                    </div>
                </section>

                {selectedLog && (
                    <AuditLogDetailDialog
                        item={selectedLog}
                        trigger={detailTrigger}
                        onClose={() => {
                            setSelectedLog(null);
                            setDetailTrigger(null);
                        }}
                    />
                )}
            </div>
            {stepUp.dialog}
        </>
    );
}
