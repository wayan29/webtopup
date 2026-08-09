import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiV2 } from '../../api';
import { useStepUpOrchestration } from '../../auth/useStepUpOrchestration';
import { stepUpActionErrorMessage } from '../../auth/withStepUp';
import {
    AlertTriangle,
    CheckCircle,
    Download,
    Gift,
    Loader2,
    RefreshCw,
    Sparkles,
    Users,
} from 'lucide-react';

type Winner = {
    userId: string;
    name: string;
    email: string;
    amount: number;
};

type Campaign = {
    _id: string;
    name: string;
    totalPool: number;
    winnerCount: number;
    minAmount?: number;
    maxAmount?: number;
    status: string;
    note?: string;
    seed?: string;
    createdAt: string;
    createdBy?: { name?: string; email?: string };
    winners?: Winner[];
    allocatedTotal?: number;
    executionAvailable?: boolean;
};

type Preview = {
    name: string;
    totalPool: number;
    winnerCount: number;
    minAmount: number;
    maxAmount: number;
    note: string;
    eligibleMembers: number;
    winners: Winner[];
    allocatedTotal: number;
    executionAvailable: boolean;
};

const formatCurrency = (value: number) => `Rp${Math.max(0, value || 0).toLocaleString('id-ID')}`;
const formatDateTime = (value?: string) =>
    value
        ? new Date(value).toLocaleString('id-ID', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        })
        : '-';

const fieldClass = 'w-full rounded-xl border px-3 py-2.5 text-sm ui-field';

export function giveawayExecutionErrorMessage(error: unknown): string {
    const response = (error as {
        response?: { status?: number; data?: { error?: { code?: string }; code?: string; message?: string } };
    })?.response;
    const code = response?.data?.error?.code || response?.data?.code;
    if (response?.status === 503 && code === 'GIVEAWAY_TRANSACTIONS_UNAVAILABLE') {
        return 'Eksekusi sementara tidak tersedia karena MongoDB transaction belum aktif. Preview dan riwayat tetap dapat digunakan.';
    }
    if (response?.status === 503 && code === 'GIVEAWAY_COMMIT_UNKNOWN') {
        return 'Status commit belum dapat dipastikan. Jangan gunakan key baru; lakukan rekonsiliasi dengan Idempotency-Key yang sama.';
    }
    if (response?.status === 409 && code === 'IDEMPOTENCY_CONFLICT') {
        return 'Idempotency-Key sudah digunakan untuk payload berbeda. Gunakan key baru setelah memeriksa riwayat campaign.';
    }
    if (response?.status === 409 && code === 'IDEMPOTENCY_IN_PROGRESS') {
        return 'Giveaway dengan key yang sama masih diproses atau perlu rekonsiliasi. Jangan gunakan key baru.';
    }
    return response?.data?.message || 'Gagal mengeksekusi bagikan saldo';
}

export default function BalanceGiveawayPanel() {
    const stepUp = useStepUpOrchestration();
    const [campaigns, setCampaigns] = useState<Campaign[]>([]);
    const [executionAvailable, setExecutionAvailable] = useState(false);
    const [loading, setLoading] = useState(true);
    const [previewing, setPreviewing] = useState(false);
    const [executing, setExecuting] = useState(false);
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
    const [preview, setPreview] = useState<Preview | null>(null);
    const [selected, setSelected] = useState<Campaign | null>(null);
    const [form, setForm] = useState({
        name: '',
        totalPool: '100000',
        winnerCount: '10',
        minAmount: '5000',
        maxAmount: '20000',
        note: '',
        participantFilter: 'all' as 'all' | 'has_transactions' | 'emails',
        emails: '',
        seed: '',
    });
    const [lockedSeed, setLockedSeed] = useState('');

    const fetchCampaigns = useCallback(async () => {
        setLoading(true);
        try {
            const response = await apiV2.get('/vouchers/giveaways', { params: { page: 1, limit: 30 } });
            setCampaigns(response.data?.items || []);
            // Fail closed when an older backend omits the capability field.
            setExecutionAvailable(response.data?.executionAvailable === true);
        } catch (error: any) {
            setMessage({ type: 'error', text: error.response?.data?.message || 'Gagal memuat campaign' });
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchCampaigns();
    }, [fetchCampaigns]);

    const payload = useMemo(() => ({
        name: form.name.trim(),
        totalPool: Number(form.totalPool),
        winnerCount: Number(form.winnerCount),
        minAmount: Number(form.minAmount),
        maxAmount: Number(form.maxAmount),
        note: form.note.trim(),
        participantFilter: form.participantFilter,
        emails: form.participantFilter === 'emails' ? form.emails : undefined,
        seed: (form.seed || lockedSeed || undefined) as string | undefined,
    }), [form, lockedSeed]);

    const validationError = useMemo(() => {
        if (!payload.name) return 'Nama campaign wajib diisi';
        if (!Number.isFinite(payload.totalPool) || payload.totalPool < 1) return 'Total pool tidak valid';
        if (!Number.isFinite(payload.winnerCount) || payload.winnerCount < 1 || payload.winnerCount > 100) {
            return 'Jumlah pemenang harus 1-100';
        }
        if (payload.minAmount < 1 || payload.maxAmount < payload.minAmount) {
            return 'Rentang nominal per pemenang tidak valid';
        }
        if (payload.minAmount * payload.winnerCount > payload.totalPool) {
            return 'Total pool terlalu kecil untuk min × jumlah pemenang';
        }
        if (payload.maxAmount * payload.winnerCount < payload.totalPool) {
            return 'Total pool terlalu besar untuk max × jumlah pemenang';
        }
        return '';
    }, [payload]);

    const handlePreview = async () => {
        if (validationError) {
            setMessage({ type: 'error', text: validationError });
            return;
        }
        setPreviewing(true);
        setMessage(null);
        setPreview(null);
        try {
            const response = await apiV2.post('/vouchers/giveaways/preview', payload);
            setPreview(response.data);
            // Preview remains usable even when execution is unavailable, but never enable
            // financial execution unless the backend explicitly advertises transaction support.
            setExecutionAvailable(response.data?.executionAvailable === true);
            if (response.data?.seed) setLockedSeed(String(response.data.seed));
        } catch (error: any) {
            setMessage({ type: 'error', text: error.response?.data?.message || 'Gagal preview undian' });
        } finally {
            setPreviewing(false);
        }
    };

    const handleExecute = async () => {
        if (validationError) {
            setMessage({ type: 'error', text: validationError });
            return;
        }
        if (!preview) {
            setMessage({ type: 'error', text: 'Jalankan preview dulu sebelum mengeksekusi' });
            return;
        }
        if (!executionAvailable) {
            setMessage({
                type: 'error',
                text: 'Eksekusi giveaway sementara tidak tersedia karena MongoDB transaction belum aktif.',
            });
            return;
        }
        setExecuting(true);
        setMessage(null);
        try {
            const idempotencyKey =
                typeof crypto !== 'undefined' && 'randomUUID' in crypto
                    ? crypto.randomUUID()
                    : `giveaway-${Date.now()}`;
            const response = await stepUp.run('finance.adjust_balance', (config) =>
                apiV2.post('/vouchers/giveaways', {
                    ...payload,
                    seed: lockedSeed || payload.seed,
                }, {
                    ...(config as object),
                    headers: {
                        ...((config as { headers?: Record<string, string> })?.headers || {}),
                        'X-Idempotency-Key': idempotencyKey,
                    },
                } as never),
            );
            setMessage({
                type: 'success',
                text: response.data?.message || 'Bagikan saldo random berhasil',
            });
            setPreview(null);
            setForm((current) => ({ ...current, name: '', note: '' }));
            await fetchCampaigns();
            if (response.data?.campaign) {
                setSelected(response.data.campaign);
            }
        } catch (error: any) {
            const text = stepUpActionErrorMessage(error, giveawayExecutionErrorMessage(error));
            if (text) setMessage({ type: 'error', text });
        } finally {
            setExecuting(false);
        }
    };

    const openDetail = async (id: string) => {
        try {
            const response = await apiV2.get(`/vouchers/giveaways/${id}`);
            setSelected(response.data);
        } catch (error: any) {
            setMessage({ type: 'error', text: error.response?.data?.message || 'Gagal memuat detail' });
        }
    };

    const exportWinnersCsv = (campaign: Campaign) => {
        const winners = campaign.winners || [];
        const rows = [
            ['Campaign', 'Email', 'Nama', 'UserId', 'Nominal', 'Seed', 'Dibuat'],
            ...winners.map((w) => [
                campaign.name,
                w.email || '',
                w.name || '',
                w.userId || '',
                String(w.amount ?? 0),
                campaign.seed || '',
                campaign.createdAt || '',
            ]),
        ];
        const csv = rows
            .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
            .join('\n');
        const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `giveaway-${(campaign.name || 'winners').replace(/\s+/g, '-').toLowerCase()}.csv`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
    };

    return (
        <div className="space-y-6">
            {stepUp.dialog}
            {message ? (
                <div
                    className={`flex items-start gap-3 rounded-2xl border px-4 py-3 text-sm ${
                        message.type === 'success' ? 'ui-success-chip' : 'ui-danger-chip'
                    }`}
                >
                    {message.type === 'success' ? <CheckCircle className="mt-0.5 h-4 w-4" /> : <AlertTriangle className="mt-0.5 h-4 w-4" />}
                    <span className="flex-1">{message.text}</span>
                </div>
            ) : null}

            <div className="grid gap-6 xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
                <div className="rounded-2xl border ui-border ui-panel-muted p-6">
                    <div className="mb-5">
                        <h2 className="flex items-center gap-2 text-lg font-semibold ui-text">
                            <Gift className="h-5 w-5 ui-accent-text" />
                            Bagikan Saldo Random
                        </h2>
                        <p className="mt-1 text-sm ui-text-muted">
                            Undi N member terdaftar dan kredit saldo acak yang jumlahnya tepat = total pool.
                            Butuh step-up 2FA seperti penyesuaian saldo.
                        </p>
                    </div>

                    <div className="space-y-4">
                        <label className="block space-y-2">
                            <span className="text-sm font-medium ui-text">Nama campaign</span>
                            <input
                                value={form.name}
                                onChange={(e) => setForm((c) => ({ ...c, name: e.target.value }))}
                                className={fieldClass}
                                placeholder="Contoh: Giveaway Maret"
                            />
                        </label>
                        <div className="grid grid-cols-2 gap-3">
                            <label className="block space-y-2">
                                <span className="text-sm font-medium ui-text">Total pool (Rp)</span>
                                <input
                                    type="number"
                                    min={1}
                                    value={form.totalPool}
                                    onChange={(e) => setForm((c) => ({ ...c, totalPool: e.target.value }))}
                                    className={fieldClass}
                                />
                            </label>
                            <label className="block space-y-2">
                                <span className="text-sm font-medium ui-text">Jumlah pemenang</span>
                                <input
                                    type="number"
                                    min={1}
                                    max={100}
                                    value={form.winnerCount}
                                    onChange={(e) => setForm((c) => ({ ...c, winnerCount: e.target.value }))}
                                    className={fieldClass}
                                />
                            </label>
                            <label className="block space-y-2">
                                <span className="text-sm font-medium ui-text">Min / orang</span>
                                <input
                                    type="number"
                                    min={1}
                                    value={form.minAmount}
                                    onChange={(e) => setForm((c) => ({ ...c, minAmount: e.target.value }))}
                                    className={fieldClass}
                                />
                            </label>
                            <label className="block space-y-2">
                                <span className="text-sm font-medium ui-text">Max / orang</span>
                                <input
                                    type="number"
                                    min={1}
                                    value={form.maxAmount}
                                    onChange={(e) => setForm((c) => ({ ...c, maxAmount: e.target.value }))}
                                    className={fieldClass}
                                />
                            </label>
                        </div>
                        <label className="block space-y-2">
                            <span className="text-sm font-medium ui-text">Filter peserta</span>
                            <select
                                value={form.participantFilter}
                                onChange={(e) => setForm((c) => ({
                                    ...c,
                                    participantFilter: e.target.value as 'all' | 'has_transactions' | 'emails',
                                }))}
                                className={fieldClass}
                            >
                                <option value="all">Semua member</option>
                                <option value="has_transactions">Pernah transaksi</option>
                                <option value="emails">Daftar email</option>
                            </select>
                        </label>
                        {form.participantFilter === 'emails' ? (
                            <label className="block space-y-2">
                                <span className="text-sm font-medium ui-text">Email peserta</span>
                                <textarea
                                    value={form.emails}
                                    onChange={(e) => setForm((c) => ({ ...c, emails: e.target.value }))}
                                    className={fieldClass}
                                    rows={3}
                                    placeholder="satu@email.com, dua@email.com"
                                />
                            </label>
                        ) : null}
                        {lockedSeed ? (
                            <p className="text-xs ui-text-muted">
                                Seed preview terkunci: <span className="font-mono">{lockedSeed}</span> (eksekusi memakai undian yang sama)
                            </p>
                        ) : null}
                        <label className="block space-y-2">
                            <span className="text-sm font-medium ui-text">Catatan (opsional)</span>
                            <textarea
                                value={form.note}
                                onChange={(e) => setForm((c) => ({ ...c, note: e.target.value }))}
                                className={fieldClass}
                                rows={2}
                                placeholder="Alasan campaign / channel promo"
                            />
                        </label>

                        {!validationError && Number(form.totalPool) > 0 && Number(form.winnerCount) > 0 ? (
                            <div className="rounded-xl border ui-border ui-panel px-3 py-2.5 text-sm">
                                <p className="ui-text-muted">Ringkasan</p>
                                <p className="mt-0.5 font-semibold ui-text">
                                    {formatCurrency(Number(form.totalPool))} → {form.winnerCount} pemenang
                                    {' '}(± {formatCurrency(Math.floor(Number(form.totalPool) / Math.max(1, Number(form.winnerCount))))}/org rata-rata)
                                </p>
                            </div>
                        ) : null}

                        <div className="flex flex-col gap-2 sm:flex-row">
                            <button
                                type="button"
                                onClick={handlePreview}
                                disabled={previewing || Boolean(validationError)}
                                className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl border px-4 py-3 text-sm font-semibold ui-muted-action disabled:opacity-50"
                            >
                                {previewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                                Preview undian
                            </button>
                            <button
                                type="button"
                                onClick={handleExecute}
                                disabled={executing || !preview || !executionAvailable || Boolean(validationError)}
                                className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl ui-accent-solid px-4 py-3 text-sm font-semibold disabled:opacity-50"
                            >
                                {executing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Users className="h-4 w-4" />}
                                Eksekusi & kredit
                            </button>
                        </div>
                        {!executionAvailable ? (
                            <div className="rounded-xl border ui-border ui-danger-chip px-3 py-2.5 text-xs">
                                Eksekusi sementara tidak tersedia karena MongoDB transaction belum aktif.
                                Preview dan riwayat tetap dapat digunakan.
                            </div>
                        ) : null}
                        <p className="text-xs ui-text-muted">
                            Preview menampilkan undian simulasi (tidak mengkredit). Eksekusi mengundi ulang dan langsung menambah saldo member.
                        </p>
                    </div>
                </div>

                <div className="space-y-4">
                    {preview ? (
                        <div className="rounded-2xl border ui-border ui-panel-muted overflow-hidden">
                            <div className="border-b ui-border px-5 py-4">
                                <p className="text-xs font-semibold uppercase tracking-[0.16em] ui-accent-text">Preview</p>
                                <h3 className="mt-1 text-lg font-semibold ui-text">{preview.name}</h3>
                                <p className="text-sm ui-text-muted">
                                    {preview.eligibleMembers} member eligible · total alokasi {formatCurrency(preview.allocatedTotal)}
                                </p>
                            </div>
                            <div className="max-h-72 overflow-y-auto">
                                <table className="min-w-full">
                                    <thead className="ui-panel sticky top-0">
                                        <tr className="text-xs uppercase ui-text-muted">
                                            <th className="px-4 py-2 text-left">User</th>
                                            <th className="px-4 py-2 text-right">Nominal</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y ui-border">
                                        {preview.winners.map((winner) => (
                                            <tr key={winner.userId}>
                                                <td className="px-4 py-2 text-sm">
                                                    <div className="font-medium ui-text">{winner.name || '-'}</div>
                                                    <div className="text-xs ui-text-muted">{winner.email}</div>
                                                </td>
                                                <td className="px-4 py-2 text-right text-sm font-semibold ui-accent-text">
                                                    {formatCurrency(winner.amount)}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    ) : null}

                    <div className="rounded-2xl border ui-border ui-panel-muted overflow-hidden">
                        <div className="flex items-center justify-between border-b ui-border px-5 py-4">
                            <div>
                                <h3 className="text-lg font-semibold ui-text">Riwayat campaign</h3>
                                <p className="text-xs ui-text-muted">Campaign yang sudah dieksekusi</p>
                            </div>
                            <button
                                type="button"
                                onClick={fetchCampaigns}
                                className="inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold ui-muted-action"
                            >
                                <RefreshCw className="h-3.5 w-3.5" />
                                Segarkan
                            </button>
                        </div>
                        {loading ? (
                            <div className="flex justify-center py-12">
                                <Loader2 className="h-7 w-7 animate-spin ui-accent-text" />
                            </div>
                        ) : campaigns.length === 0 ? (
                            <div className="px-5 py-12 text-center text-sm ui-text-muted">
                                Belum ada campaign bagikan saldo.
                            </div>
                        ) : (
                            <div className="divide-y ui-border">
                                {campaigns.map((campaign) => (
                                    <button
                                        key={campaign._id}
                                        type="button"
                                        onClick={() => openDetail(campaign._id)}
                                        className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left hover:bg-[var(--ui-card-bg)]"
                                    >
                                        <div className="min-w-0">
                                            <p className="truncate font-semibold ui-text">{campaign.name}</p>
                                            <p className="mt-1 text-xs ui-text-muted">
                                                {formatCurrency(campaign.totalPool)} · {campaign.winnerCount} pemenang · {formatDateTime(campaign.createdAt)}
                                            </p>
                                        </div>
                                        <span className="ui-success-chip shrink-0 rounded-full border px-2 py-1 text-[10px] font-bold uppercase">
                                            {campaign.status}
                                        </span>
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {selected ? (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
                    <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border ui-border ui-panel shadow-2xl">
                        <div className="border-b ui-border px-5 py-4">
                            <h3 className="text-lg font-semibold ui-text">{selected.name}</h3>
                            <p className="text-sm ui-text-muted">
                                {formatCurrency(selected.totalPool)} · {selected.winnerCount} pemenang · {formatDateTime(selected.createdAt)}
                            </p>
                        </div>
                        <div className="divide-y ui-border">
                            {(selected.winners || []).map((winner) => (
                                <div key={winner.userId} className="flex items-center justify-between gap-3 px-5 py-3">
                                    <div className="min-w-0">
                                        <p className="truncate text-sm font-medium ui-text">{winner.name || '-'}</p>
                                        <p className="truncate text-xs ui-text-muted">{winner.email}</p>
                                    </div>
                                    <span className="shrink-0 text-sm font-bold ui-accent-text">{formatCurrency(winner.amount)}</span>
                                </div>
                            ))}
                        </div>
                        <div className="flex flex-col gap-2 border-t ui-border p-4 sm:flex-row">
                            <button
                                type="button"
                                onClick={() => selected && exportWinnersCsv(selected)}
                                className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-semibold ui-muted-action"
                            >
                                <Download className="h-4 w-4" />
                                Export CSV pemenang
                            </button>
                            <button
                                type="button"
                                onClick={() => setSelected(null)}
                                className="flex-1 rounded-xl border px-4 py-2.5 text-sm font-semibold ui-muted-action"
                            >
                                Tutup
                            </button>
                        </div>
                    </div>
                </div>
            ) : null}
        </div>
    );
}
