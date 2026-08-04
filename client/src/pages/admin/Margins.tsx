import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Info, Loader2, RefreshCcw, RotateCcw, Save, ShieldCheck,} from 'lucide-react';
import { apiV2 } from '../../api';

type MarginTier = 'basic' | 'gold' | 'platinum';

type MarginConfig = Record<MarginTier, number>;

interface MarginAuditMeta {
    updatedAt: string | null;
    updatedBy: {
        email: string;
        role: string;
    } | null;
}

const DEFAULT_MARGINS: MarginConfig = {
    basic: 10,
    gold: 5,
    platinum: 0
};

const MAX_MARGIN_PERCENT = 500;
const SAMPLE_COST = 100000;
const TIERS: Array<{ key: MarginTier; label: string; accent: string }> = [
    { key: 'basic', label: 'Basic', accent: 'ui-info-chip' },
    { key: 'gold', label: 'Gold', accent: 'ui-warning-chip' },
    { key: 'platinum', label: 'Platinum', accent: 'ui-accent-chip' }
];

export default function AdminMargins() {
    const [margins, setMargins] = useState<MarginConfig>(DEFAULT_MARGINS);
    const [note, setNote] = useState('');
    const [meta, setMeta] = useState<MarginAuditMeta>({ updatedAt: null, updatedBy: null });
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const latestRequestId = useRef(0);

    const fetchMargins = useCallback(async () => {
        const requestId = latestRequestId.current + 1;
        latestRequestId.current = requestId;

        try {
            setLoading(true);
            setMessage(null);
            const res = await apiV2
                .get('/margins');
            if (requestId !== latestRequestId.current) return;
            if (res.data?.success && res.data?.data) {
                const data = res.data.data;
                setMargins({
                    basic: data.basic ?? DEFAULT_MARGINS.basic,
                    gold: data.gold ?? DEFAULT_MARGINS.gold,
                    platinum: data.platinum ?? DEFAULT_MARGINS.platinum
                });
                setNote(data.note || '');
                setMeta({
                    updatedAt: res.data?.meta?.updatedAt ?? null,
                    updatedBy: res.data?.meta?.updatedBy ?? null
                });
            }
        } catch (error: any) {
            if (requestId !== latestRequestId.current) return;
            console.error('Failed to fetch margins:', error);
            setMessage({
                type: 'error',
                text: error.response?.data?.message || 'Gagal memuat konfigurasi margin. Draft tidak diubah.'
            });
        } finally {
            if (requestId === latestRequestId.current) {
                setLoading(false);
            }
        }
    }, []);

    useEffect(() => {
        fetchMargins();
    }, [fetchMargins]);

    useEffect(() => {
        const handler = () => fetchMargins();
        window.addEventListener('admin:refresh-current-page', handler);
        return () => window.removeEventListener('admin:refresh-current-page', handler);
    }, [fetchMargins]);

    const handleChange = (key: MarginTier, value: string) => {
        if (value.trim() === '') {
            setMargins((prev) => ({ ...prev, [key]: 0 }));
            return;
        }

        const num = Number(value);
        if (!Number.isFinite(num)) {
            return;
        }

        setMargins((prev) => ({
            ...prev,
            [key]: Math.min(Math.max(num, 0), MAX_MARGIN_PERCENT)
        }));
    };

    const handleSave = async () => {
        const invalidTier = TIERS.find(({ key }) => (
            !Number.isFinite(margins[key]) || margins[key] < 0 || margins[key] > MAX_MARGIN_PERCENT
        ));

        if (invalidTier) {
            setMessage({
                type: 'error',
                text: `Margin ${invalidTier.label} harus di antara 0% sampai ${MAX_MARGIN_PERCENT}%.`
            });
            return;
        }

        try {
            setSaving(true);
            setMessage(null);
            const payload = { ...margins, note };
            const res = await apiV2
                .put('/margins', payload);
            if (res.data?.success) {
                if (res.data?.data) {
                    setMargins({
                        basic: res.data.data.basic ?? DEFAULT_MARGINS.basic,
                        gold: res.data.data.gold ?? DEFAULT_MARGINS.gold,
                        platinum: res.data.data.platinum ?? DEFAULT_MARGINS.platinum
                    });
                    setNote(res.data.data.note || '');
                }
                setMeta({
                    updatedAt: res.data?.meta?.updatedAt ?? new Date().toISOString(),
                    updatedBy: res.data?.meta?.updatedBy ?? null
                });
                setMessage({ type: 'success', text: 'Margin berhasil disimpan.' });
            } else {
                setMessage({ type: 'error', text: res.data?.message || 'Gagal menyimpan margin.' });
            }
        } catch (error: any) {
            setMessage({ type: 'error', text: error.response?.data?.message || 'Gagal menyimpan margin.' });
        } finally {
            setSaving(false);
        }
    };

    const handleResetDefaults = () => {
        setMargins(DEFAULT_MARGINS);
        setNote('');
        setMessage(null);
    };

    const formatCurrency = (value: number) => new Intl.NumberFormat('id-ID', {
        style: 'currency',
        currency: 'IDR',
        maximumFractionDigits: 0
    }).format(value);

    const formatUpdatedAt = (value: string | null) => {
        if (!value) {
            return 'Belum pernah diperbarui';
        }

        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) {
            return 'Waktu update tidak valid';
        }

        return new Intl.DateTimeFormat('id-ID', {
            dateStyle: 'medium',
            timeStyle: 'short'
        }).format(parsed);
    };

    return (
        <div className="space-y-6">
            <div className="ui-panel-muted w-fit rounded-2xl border ui-border px-4 py-3 text-sm ui-text-muted">
                <div className="flex items-center gap-2 ui-accent-text">
                    <ShieldCheck className="h-4 w-4" />
                    <span className="font-semibold">Audit terakhir</span>
                </div>
                <p className="mt-2 ui-text">{formatUpdatedAt(meta.updatedAt)}</p>
                <p className="text-xs ui-text-muted">
                    {meta.updatedBy ? `${meta.updatedBy.email} (${meta.updatedBy.role})` : 'Belum ada riwayat perubahan tersimpan'}
                </p>
            </div>

            {message && (
                <div className={`p-4 rounded-lg border text-sm flex items-center gap-2 ${message.type === 'success' ? 'ui-success-chip' : 'ui-danger-chip'}`} role="alert" aria-live="polite">
                    <span className="flex-1">{message.text}</span>
                    <button type="button" onClick={() => setMessage(null)} className="rounded-lg px-2 py-1 text-xs font-semibold ui-muted-action">
                        Tutup
                    </button>
                </div>
            )}

            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.75fr)]">
                <div className="ui-panel-muted rounded-xl border ui-border overflow-hidden">
                    <div className="p-4 flex items-center gap-2 text-sm ui-accent-text ui-panel border-b ui-border">
                        <Info className="w-4 h-4" />
                        <span>Margin dihitung sebagai mark up dari modal. Perubahan hanya bisa dilakukan oleh tim dengan izin produk.</span>
                    </div>

                    <div className="p-4 space-y-4">
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                            {TIERS.map(({ key, label }) => (
                                <div key={key} className="p-3 border ui-border rounded-lg ui-panel">
                                    <div className="flex items-start justify-between gap-3">
                                        <div>
                                            <p className="text-sm font-semibold ui-text">{label}</p>
                                            <p className="text-xs ui-text-muted mb-2">Tambah margin (%)</p>
                                        </div>
                                        <span className="ui-accent-chip rounded-full border px-2 py-1 text-[11px] font-semibold uppercase tracking-wide">
                                            {margins[key]}%
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <input
                                            type="number"
                                            min="0"
                                            max={MAX_MARGIN_PERCENT}
                                            step="0.1"
                                            value={margins[key]}
                                            onChange={(e) => handleChange(key, e.target.value)}
                                            disabled={loading || saving}
                                            className="w-full rounded-lg border px-3 py-2 text-sm ui-field disabled:cursor-not-allowed disabled:opacity-60"
                                        />
                                        <span className="text-sm ui-text-muted">%</span>
                                    </div>
                                </div>
                            ))}
                        </div>

                        <div>
                            <div className="mb-1 flex items-center justify-between gap-3">
                                <label className="block text-sm font-medium ui-text">Catatan internal</label>
                                <span className="text-xs ui-text-muted">{note.trim().length}/500</span>
                            </div>
                            <textarea
                                value={note}
                                onChange={(e) => setNote(e.target.value.slice(0, 500))}
                                disabled={loading || saving}
                                rows={4}
                                className="w-full rounded-lg border px-3 py-2 text-sm ui-field disabled:cursor-not-allowed disabled:opacity-60"
                                placeholder="Misal: margin promo akhir tahun atau penyesuaian vendor tertentu"
                            />
                        </div>

                        <div className="rounded-xl border p-4 text-sm ui-warning-chip">
                            <div className="flex items-start gap-3">
                                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 ui-warning-text" />
                                <div className="space-y-1">
                                    <p className="font-semibold ui-text">Batas aman margin</p>
                                    <p>Server hanya menerima nilai 0% sampai {MAX_MARGIN_PERCENT}%. Simpan perubahan hanya setelah seluruh tier pada draft sudah sesuai.</p>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="p-4 border-t ui-border flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex flex-wrap items-center gap-2">
                            <button
                                type="button"
                                onClick={fetchMargins}
                                disabled={saving || loading}
                                className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium ui-muted-action transition-colors hover:border-[var(--ui-accent)] disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                <RefreshCcw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                                Segarkan
                            </button>
                            <button
                                type="button"
                                onClick={handleResetDefaults}
                                disabled={saving || loading}
                                className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium ui-muted-action transition-colors hover:border-[var(--ui-accent)] disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                <RotateCcw className="h-4 w-4" />
                                Reset Draft
                            </button>
                        </div>

                        <button
                            onClick={handleSave}
                            disabled={saving || loading}
                            className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg ui-accent-solid text-sm font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                            {saving ? 'Menyimpan...' : 'Simpan Margin'}
                        </button>
                    </div>
                </div>

                <div className="space-y-4">
                    <div className="ui-panel-muted rounded-xl border ui-border p-4">
                        <div className="flex items-center justify-between gap-3">
                            <div>
                                <p className="text-xs uppercase tracking-[0.16em] ui-accent-text">Live preview</p>
                                <h2 className="mt-1 text-lg font-bold ui-text">Simulasi harga jual</h2>
                            </div>
                            <div className="ui-accent-chip rounded-full border px-3 py-1 text-xs font-semibold">
                                Modal contoh {formatCurrency(SAMPLE_COST)}
                            </div>
                        </div>

                        <div className="mt-4 space-y-3">
                            {TIERS.map(({ key, label, accent }) => {
                                const sellPrice = Math.round(SAMPLE_COST * (1 + margins[key] / 100));
                                const grossProfit = sellPrice - SAMPLE_COST;

                                return (
                                    <div key={key} className="rounded-xl border ui-border ui-panel p-4">
                                        <div className="flex items-center justify-between gap-3">
                                            <span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${accent}`}>
                                                {label}
                                            </span>
                                            <span className="text-sm font-semibold ui-text">+{margins[key]}%</span>
                                        </div>
                                        <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                                            <div>
                                                <p className="ui-text-muted">Harga jual</p>
                                                <p className="mt-1 font-semibold ui-text">{formatCurrency(sellPrice)}</p>
                                            </div>
                                            <div>
                                                <p className="ui-text-muted">Margin kotor</p>
                                                <p className="mt-1 font-semibold ui-success-text">{formatCurrency(grossProfit)}</p>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    <div className="ui-panel-muted rounded-xl border ui-border p-4">
                        <p className="text-xs uppercase tracking-[0.16em] ui-accent-text">Catatan operasional</p>
                        <ul className="mt-3 space-y-3 text-sm ui-text">
                            <li className="rounded-lg border ui-border ui-panel p-3">
                                Endpoint margin sekarang hanya terbuka untuk role yang punya izin `manageProducts`.
                            </li>
                            <li className="rounded-lg border ui-border ui-panel p-3">
                                Produk tetap boleh override harga manual. Margin ini hanya default otomatis.
                            </li>
                            <li className="rounded-lg border ui-border ui-panel p-3">
                                Simpan perubahan hanya setelah Anda memastikan dampaknya ke seluruh katalog.
                            </li>
                        </ul>
                    </div>
                </div>
            </div>
        </div>
    );
}
