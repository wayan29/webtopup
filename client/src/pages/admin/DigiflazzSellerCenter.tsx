import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
    AlertCircle,
    Cable,
    CheckCircle2,
    LayoutDashboard,
    Loader2,
    Package,
    Server,
    Zap,
} from 'lucide-react';

import { apiV2 } from '../../api';
import { useStepUpOrchestration } from '../../auth/useStepUpOrchestration';
import {
    malformedSellerCenterSummary,
    parseSellerCenterSection,
    parseSellerCenterSummary,
    SELLER_CENTER_SECTIONS,
    type SellerCenterSection,
    type SellerCenterStatus,
    type SellerCenterSummary,
} from '../../lib/digiflazzSellerCenter';
import DigiflazzSellerChannel from './DigiflazzSellerChannel';
import IrsSellerIntegration from './IrsSellerIntegration';

const SECTION_TITLES: Record<SellerCenterSection, string> = {
    overview: 'Ringkasan',
    settings: 'Konfigurasi Seller',
    mappings: 'Mapping Produk',
    orders: 'Order & Callback',
    irs: 'Integrasi IRS',
};

const SECTION_ICONS: Record<SellerCenterSection, typeof Server> = {
    overview: LayoutDashboard,
    settings: Server,
    mappings: Zap,
    orders: Cable,
    irs: Package,
};

const STATUS_LABELS: Record<SellerCenterStatus, string> = {
    ready: 'Siap',
    disabled: 'Nonaktif',
    needs_setup: 'Perlu setup',
    attention: 'Perlu tindakan',
    unavailable: 'Tidak tersedia',
};

const STATUS_CHIP: Record<SellerCenterStatus, string> = {
    ready: 'ui-success-chip',
    disabled: 'ui-panel-muted ui-text-muted',
    needs_setup: 'ui-warning-chip',
    attention: 'ui-warning-chip',
    unavailable: 'ui-danger-chip',
};

export type SellerCenterChildProps = {
    section: SellerCenterSection;
    refreshRevision: number;
    onMutationComplete: () => void;
    onNavigateSection: (section: SellerCenterSection) => void;
};

const DigiflazzSellerCenter = () => {
    const stepUp = useStepUpOrchestration();
    const [searchParams, setSearchParams] = useSearchParams();
    const section = parseSellerCenterSection(searchParams.get('section'));

    const [summary, setSummary] = useState<SellerCenterSummary>(() => malformedSellerCenterSummary());
    const [summaryLoading, setSummaryLoading] = useState(true);
    const [summaryError, setSummaryError] = useState('');
    const [refreshRevision, setRefreshRevision] = useState(0);
    const latestSummaryRequestId = useRef(0);

    const loadSummary = useCallback(async () => {
        const requestId = ++latestSummaryRequestId.current;
        setSummaryLoading(true);
        setSummaryError('');
        try {
            const response = await apiV2.get('/digiflazz-seller/center-summary');
            const parsed = parseSellerCenterSummary(response.data);
            if (requestId !== latestSummaryRequestId.current) return;
            setSummary(parsed);
            if (!parsed.ok) {
                setSummaryError('Status Seller Center tidak bisa dibaca dengan benar.');
            }
        } catch {
            if (requestId !== latestSummaryRequestId.current) return;
            setSummary(malformedSellerCenterSummary());
            setSummaryError('Status Seller Center tidak bisa dimuat.');
        } finally {
            if (requestId === latestSummaryRequestId.current) {
                setSummaryLoading(false);
            }
        }
    }, []);

    // The AdminLayout global refresh button is the only pure refresh affordance.
    useEffect(() => {
        const handler = () => {
            setRefreshRevision((current) => current + 1);
            void loadSummary();
        };
        window.addEventListener('admin:refresh-current-page', handler);
        return () => window.removeEventListener('admin:refresh-current-page', handler);
    }, [loadSummary]);

    useEffect(() => {
        void loadSummary();
    }, [loadSummary]);

    const navigateToSection = useCallback(
        (next: SellerCenterSection) => {
            // Keep only the allowlisted `section` query param.
            setSearchParams(next === 'overview' ? {} : { section: next }, { replace: true });
        },
        [setSearchParams],
    );

    const handleMutationComplete = useCallback(() => {
        setRefreshRevision((current) => current + 1);
        void loadSummary();
    }, [loadSummary]);

    const childProps: SellerCenterChildProps = useMemo(
        () => ({
            section,
            refreshRevision,
            onMutationComplete: handleMutationComplete,
            onNavigateSection: navigateToSection,
        }),
        [section, refreshRevision, handleMutationComplete, navigateToSection],
    );

    return (
        <div className="space-y-5">
            <nav
                aria-label="Navigasi Digiflazz Seller Center"
                className="flex flex-wrap gap-2 border-b ui-border"
            >
                {SELLER_CENTER_SECTIONS.map((key) => {
                    const Icon = SECTION_ICONS[key];
                    const active = section === key;
                    return (
                        <button
                            key={key}
                            type="button"
                            onClick={() => navigateToSection(key)}
                            aria-current={active ? 'page' : undefined}
                            className={`inline-flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-semibold transition-colors ${
                                active
                                    ? 'border-[var(--ui-accent)] ui-accent-text'
                                    : 'border-transparent ui-text-muted hover:text-[var(--ui-text)]'
                            }`}
                        >
                            <Icon className="h-4 w-4" />
                            {SECTION_TITLES[key]}
                        </button>
                    );
                })}
            </nav>

            <div aria-busy={summaryLoading} role="status" className="sr-only">
                {summaryLoading ? 'Memuat status Seller Center' : `Status Seller Center: ${SECTION_TITLES[section]}`}
            </div>

            {(summaryError || summary.issues.length > 0) && (
                <div role="alert" className="rounded-xl border px-4 py-3 text-sm ui-danger-chip">
                    {summaryError || 'Sebagian status Seller Center tidak tersedia.'}
                    {summary.issues.length > 0 && (
                        <ul className="mt-1 list-inside list-disc text-xs">
                            {summary.issues.map((issue) => (
                                <li key={issue.code}>{issue.code}</li>
                            ))}
                        </ul>
                    )}
                </div>
            )}

            {section === 'overview' && (
                <SellerCenterOverview summary={summary} loading={summaryLoading} onNavigateSection={navigateToSection} />
            )}
            {(section === 'settings' || section === 'mappings' || section === 'orders') && (
                <DigiflazzSellerChannel {...childProps} stepUp={stepUp} />
            )}
            {section === 'irs' && <IrsSellerIntegration {...childProps} stepUp={stepUp} />}

            {stepUp.dialog}
        </div>
    );
};

const SellerCenterOverview = ({
    summary,
    loading,
    onNavigateSection,
}: {
    summary: SellerCenterSummary;
    loading: boolean;
    onNavigateSection: (section: SellerCenterSection) => void;
}) => (
    <div className="space-y-4" aria-busy={loading}>
        <div className="grid gap-4 xl:grid-cols-2">
            <div className="rounded-xl border ui-border ui-panel-muted p-5">
                <div className="flex items-center justify-between gap-3">
                    <div className="text-xs uppercase tracking-[0.18em] ui-accent-text">Digiflazz API</div>
                    {loading ? (
                        <Loader2 className="h-4 w-4 animate-spin ui-text-muted" />
                    ) : (
                        <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold ${STATUS_CHIP[summary.digiflazz.status]}`}>
                            {summary.digiflazz.status === 'ready' ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertCircle className="h-3.5 w-3.5" />}
                            {STATUS_LABELS[summary.digiflazz.status]}
                        </span>
                    )}
                </div>
                <div className="mt-3 grid grid-cols-3 gap-3 text-sm">
                    <div>
                        <div className="text-xs ui-text-muted">Order</div>
                        <div className="mt-1 text-xl font-black ui-text">{summary.digiflazz.orders.total}</div>
                    </div>
                    <div>
                        <div className="text-xs ui-text-muted">Pending</div>
                        <div className="mt-1 text-xl font-black ui-text">{summary.digiflazz.orders.pending}</div>
                    </div>
                    <div>
                        <div className="text-xs ui-text-muted">Callback Tertunda</div>
                        <div className="mt-1 text-xl font-black ui-text">{summary.digiflazz.orders.callbackPending}</div>
                    </div>
                </div>
                <button
                    type="button"
                    onClick={() => onNavigateSection('settings')}
                    className="mt-4 rounded-lg border px-3 py-2 text-xs font-semibold ui-muted-action hover:border-[var(--ui-accent)]"
                >
                    Kelola Konfigurasi Seller
                </button>
            </div>

            <div className="rounded-xl border ui-border ui-panel-muted p-5">
                <div className="flex items-center justify-between gap-3">
                    <div className="text-xs uppercase tracking-[0.18em] ui-accent-text">Integrasi IRS</div>
                    {loading ? (
                        <Loader2 className="h-4 w-4 animate-spin ui-text-muted" />
                    ) : (
                        <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold ${STATUS_CHIP[summary.irs.status]}`}>
                            {STATUS_LABELS[summary.irs.status]}
                        </span>
                    )}
                </div>
                <div className="mt-3 grid grid-cols-3 gap-3 text-sm">
                    <div>
                        <div className="text-xs ui-text-muted">Order</div>
                        <div className="mt-1 text-xl font-black ui-text">{summary.irs.orders.total}</div>
                    </div>
                    <div>
                        <div className="text-xs ui-text-muted">Pending</div>
                        <div className="mt-1 text-xl font-black ui-text">{summary.irs.orders.pending}</div>
                    </div>
                    <div>
                        <div className="text-xs ui-text-muted">Gagal</div>
                        <div className="mt-1 text-xl font-black ui-text">{summary.irs.orders.failed}</div>
                    </div>
                </div>
                <button
                    type="button"
                    onClick={() => onNavigateSection('irs')}
                    className="mt-4 rounded-lg border px-3 py-2 text-xs font-semibold ui-muted-action hover:border-[var(--ui-accent)]"
                >
                    Kelola Integrasi IRS
                </button>
            </div>
        </div>

        <div className="rounded-xl border ui-border ui-panel-muted p-5">
            <div className="text-xs uppercase tracking-[0.18em] ui-accent-text">Mapping Produk Bersama</div>
            <div className="mt-2 text-3xl font-black ui-text">{summary.mappings.active}</div>
            <p className="mt-1 text-sm ui-text-muted">
                dari {summary.mappings.total} mapping Digiflazz/IRS yang tersimpan.
            </p>
            <button
                type="button"
                onClick={() => onNavigateSection('mappings')}
                className="mt-4 rounded-lg border px-3 py-2 text-xs font-semibold ui-muted-action hover:border-[var(--ui-accent)]"
            >
                Kelola Mapping Produk
            </button>
        </div>
    </div>
);

export default DigiflazzSellerCenter;
