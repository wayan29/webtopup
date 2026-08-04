import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiV2 } from '../../api';
import {
    AlertCircle,
    Boxes,
    FolderSearch,
    Loader2,
    RefreshCw,
    ShieldAlert,
    ShieldCheck,
    Wrench
} from 'lucide-react';

type CatalogIssueItem = {
    _id: string;
    code: string;
    name: string;
    status: boolean;
    category: string;
    brand: string;
    categoryId: string;
    operatorId: string;
    productTypeId: string;
    issues: string[];
};

type EmptyEntityItem = {
    name: string;
    slug: string;
    categoryId?: string;
    operatorId?: string;
};

type CatalogAuditResponse = {
    generatedAt: string;
    summary: {
        categories: number;
        operators: number;
        productTypes: number;
        products: number;
        productsWithIssues: number;
        emptyActiveCategories: number;
        emptyActiveOperators: number;
        emptyActiveProductTypes: number;
    };
    issueCounts: Record<string, number>;
    examples: CatalogIssueItem[];
    emptyActiveCategories: EmptyEntityItem[];
    emptyActiveOperators: EmptyEntityItem[];
    emptyActiveProductTypes: EmptyEntityItem[];
};

const formatDateTime = (value: string) =>
    new Date(value).toLocaleString('id-ID', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit'
    });

const formatIssueLabel = (value: string) =>
    value
        .split('_')
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');

export default function CatalogAudit() {
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [report, setReport] = useState<CatalogAuditResponse | null>(null);

    const fetchReport = async (silent = false) => {
        try {
            if (silent) {
                setRefreshing(true);
            } else {
                setLoading(true);
            }
            setError(null);

            const res = await apiV2
                .get('/products/admin/catalog-audit?limit=25');
            setReport(res.data);
        } catch (err: any) {
            console.error('Failed to fetch catalog audit', err);
            setError(err.response?.data?.message || 'Gagal memuat audit katalog.');
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    };

    useEffect(() => {
        fetchReport();
    }, []);

    const issueEntries = useMemo(
        () => Object.entries(report?.issueCounts || {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
        [report?.issueCounts]
    );

    if (loading) {
        return (
            <div className="flex min-h-[50vh] items-center justify-center">
                <div className="flex flex-col items-center gap-3 ui-text-muted">
                    <Loader2 className="h-8 w-8 animate-spin ui-accent-text" />
                    <p className="text-sm">Memuat audit katalog...</p>
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-5">
            <div className="ui-panel-muted border ui-border rounded-xl p-4 flex flex-wrap items-center gap-3">
                <button
                    onClick={() => fetchReport(true)}
                    disabled={refreshing}
                    className="inline-flex items-center gap-2 rounded-xl border ui-border ui-panel px-4 py-2.5 text-sm font-semibold ui-text transition hover:bg-[var(--ui-card-muted)] disabled:cursor-not-allowed disabled:opacity-60"
                >
                    <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
                    Refresh Audit
                </button>
                <Link
                    to="/admin/products"
                    className="inline-flex items-center gap-2 rounded-xl ui-accent-solid px-4 py-2.5 text-sm font-semibold transition"
                >
                    <Wrench className="h-4 w-4" />
                    Buka Produk
                </Link>
                <span className="rounded-full border ui-border ui-panel px-3 py-1 text-xs ui-text-muted">
                    Update terakhir: {report?.generatedAt ? formatDateTime(report.generatedAt) : '-'}
                </span>
            </div>

            {error ? (
                <div className="ui-danger-chip rounded-2xl border px-4 py-3 text-sm">
                    {error}
                </div>
            ) : null}

            {report ? (
                <>
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
                        <div className="rounded-2xl border ui-border ui-panel-muted p-5">
                            <p className="text-xs uppercase tracking-wide ui-text-muted">Produk Bermasalah</p>
                            <p className="mt-3 text-3xl font-black ui-text">{report.summary.productsWithIssues}</p>
                            <p className="mt-2 text-sm ui-text-muted">Produk dengan relasi kategori, operator, atau tipe yang belum rapi.</p>
                        </div>
                        <div className="rounded-2xl border ui-border ui-panel-muted p-5">
                            <p className="text-xs uppercase tracking-wide ui-text-muted">Kategori / Operator / Tipe</p>
                            <p className="mt-3 text-3xl font-black ui-text">
                                {report.summary.categories} / {report.summary.operators} / {report.summary.productTypes}
                            </p>
                            <p className="mt-2 text-sm ui-text-muted">Jumlah entitas katalog aktif yang sedang dipantau audit.</p>
                        </div>
                        <div className="rounded-2xl border ui-border ui-panel-muted p-5">
                            <p className="text-xs uppercase tracking-wide ui-text-muted">Entitas Aktif Kosong</p>
                            <p className="mt-3 text-3xl font-black ui-text">
                                {report.summary.emptyActiveCategories + report.summary.emptyActiveOperators + report.summary.emptyActiveProductTypes}
                            </p>
                            <p className="mt-2 text-sm ui-text-muted">Kategori, operator, atau type aktif yang tidak punya produk sama sekali.</p>
                        </div>
                        <div className="rounded-2xl border ui-border ui-panel-muted p-5">
                            <p className="text-xs uppercase tracking-wide ui-text-muted">Status Audit</p>
                            <div className="mt-3 flex items-center gap-3">
                                {report.summary.productsWithIssues === 0 ? (
                                    <ShieldCheck className="h-8 w-8 ui-success-text" />
                                ) : (
                                    <ShieldAlert className="h-8 w-8 ui-accent-text" />
                                )}
                                <p className="text-lg font-bold ui-text">
                                    {report.summary.productsWithIssues === 0 ? 'Bersih' : 'Perlu tindakan'}
                                </p>
                            </div>
                            <p className="mt-2 text-sm ui-text-muted">
                                Audit ini fokus ke relasi katalog yang mempengaruhi tampilan dan order publik.
                            </p>
                        </div>
                    </div>

                    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1.2fr_0.8fr]">
                        <div className="rounded-2xl border ui-border ui-panel-muted">
                            <div className="border-b ui-border px-5 py-4">
                                <h2 className="text-lg font-semibold ui-text">Contoh Produk Bermasalah</h2>
                                <p className="mt-1 text-sm ui-text-muted">Menampilkan sampai 25 produk dengan issue paling relevan.</p>
                            </div>

                            {report.examples.length === 0 ? (
                                <div className="flex min-h-[260px] flex-col items-center justify-center gap-3 px-6 text-center">
                                    <ShieldCheck className="h-10 w-10 ui-success-text" />
                                    <div>
                                        <p className="text-lg font-semibold ui-text">Tidak ada masalah relasi</p>
                                        <p className="mt-1 text-sm ui-text-muted">Semua produk aktif sekarang sudah punya relasi katalog yang rapi.</p>
                                    </div>
                                </div>
                            ) : (
                                <div className="overflow-x-auto">
                                    <table className="min-w-full text-sm">
                                        <thead>
                                            <tr className="border-b ui-border text-left ui-text-muted">
                                                <th className="px-5 py-3 font-medium">Produk</th>
                                                <th className="px-5 py-3 font-medium">Legacy</th>
                                                <th className="px-5 py-3 font-medium">Relasi</th>
                                                <th className="px-5 py-3 font-medium">Issue</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {report.examples.map((item) => (
                                                <tr key={item._id} className="border-b ui-border align-top last:border-b-0">
                                                    <td className="px-5 py-4">
                                                        <p className="font-semibold ui-text">{item.name}</p>
                                                        <p className="mt-1 font-mono text-xs ui-accent-text">{item.code}</p>
                                                    </td>
                                                    <td className="px-5 py-4 ui-text-muted">
                                                        <p>Kategori: {item.category || '-'}</p>
                                                        <p className="mt-1">Brand: {item.brand || '-'}</p>
                                                    </td>
                                                    <td className="px-5 py-4 text-xs ui-text-muted">
                                                        <p>Cat: {item.categoryId || '-'}</p>
                                                        <p className="mt-1">Op: {item.operatorId || '-'}</p>
                                                        <p className="mt-1">Type: {item.productTypeId || '-'}</p>
                                                    </td>
                                                    <td className="px-5 py-4">
                                                        <div className="flex flex-wrap gap-2">
                                                            {item.issues.map((issue) => (
                                                                <span
                                                                    key={issue}
                                                                    className="inline-flex rounded-full border border-[color-mix(in_srgb,var(--ui-accent)_24%,transparent)] bg-[var(--ui-accent-soft)] px-2.5 py-1 text-[11px] font-semibold ui-accent-text"
                                                                >
                                                                    {formatIssueLabel(issue)}
                                                                </span>
                                                            ))}
                                                        </div>
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </div>

                        <div className="space-y-5">
                            <div className="rounded-2xl border ui-border ui-panel-muted p-5">
                                <div className="flex items-center gap-3">
                                    <FolderSearch className="h-5 w-5 ui-accent-text" />
                                    <h2 className="text-lg font-semibold ui-text">Ringkasan Issue</h2>
                                </div>
                                {issueEntries.length === 0 ? (
                                    <p className="mt-4 text-sm ui-text-muted">Tidak ada issue aktif.</p>
                                ) : (
                                    <div className="mt-4 space-y-3">
                                        {issueEntries.map(([issue, count]) => (
                                            <div key={issue} className="flex items-center justify-between rounded-xl border ui-border ui-panel px-4 py-3">
                                                <span className="text-sm ui-text">{formatIssueLabel(issue)}</span>
                                                <span className="rounded-full bg-[var(--ui-accent-soft)] px-2.5 py-1 text-xs font-bold ui-accent-text">
                                                    {count}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>

                            <div className="rounded-2xl border ui-border ui-panel-muted p-5">
                                <div className="flex items-center gap-3">
                                    <Boxes className="h-5 w-5 ui-accent-text" />
                                    <h2 className="text-lg font-semibold ui-text">Entitas Aktif Kosong</h2>
                                </div>
                                <div className="mt-4 space-y-4 text-sm ui-text-muted">
                                    <div>
                                        <p className="font-semibold ui-text">Kategori</p>
                                        {report.emptyActiveCategories.length === 0 ? (
                                            <p className="mt-1 ui-text-muted">Tidak ada kategori aktif yang kosong.</p>
                                        ) : (
                                            <div className="mt-2 flex flex-wrap gap-2">
                                                {report.emptyActiveCategories.map((item) => (
                                                    <span key={item.slug} className="rounded-full border ui-border ui-panel px-3 py-1 text-xs">
                                                        {item.name}
                                                    </span>
                                                ))}
                                            </div>
                                        )}
                                    </div>

                                    <div>
                                        <p className="font-semibold ui-text">Operator</p>
                                        {report.emptyActiveOperators.length === 0 ? (
                                            <p className="mt-1 ui-text-muted">Tidak ada operator aktif yang kosong.</p>
                                        ) : (
                                            <div className="mt-2 flex flex-wrap gap-2">
                                                {report.emptyActiveOperators.map((item) => (
                                                    <span key={item.slug} className="rounded-full border ui-border ui-panel px-3 py-1 text-xs">
                                                        {item.name}
                                                    </span>
                                                ))}
                                            </div>
                                        )}
                                    </div>

                                    <div>
                                        <p className="font-semibold ui-text">Jenis Produk</p>
                                        {report.emptyActiveProductTypes.length === 0 ? (
                                            <p className="mt-1 ui-text-muted">Tidak ada jenis produk aktif yang kosong.</p>
                                        ) : (
                                            <div className="mt-2 flex flex-wrap gap-2">
                                                {report.emptyActiveProductTypes.map((item) => (
                                                    <span key={`${item.operatorId || 'type'}-${item.slug}`} className="rounded-full border ui-border ui-panel px-3 py-1 text-xs">
                                                        {item.name}
                                                    </span>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>

                            <div className="rounded-2xl border ui-border ui-panel-muted p-5">
                                <div className="flex items-start gap-3">
                                    <AlertCircle className="mt-0.5 h-5 w-5 ui-warning-text" />
                                    <div>
                                        <h2 className="text-lg font-semibold ui-text">Tindakan Lanjut</h2>
                                        <p className="mt-2 text-sm ui-text-muted">
                                            Audit ini hanya membaca data. Perbaikan bulk tetap dilakukan lewat script remediation atau edit data produk/katalog dari panel admin.
                                        </p>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </>
            ) : null}
        </div>
    );
}
