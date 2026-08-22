import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    AlertCircle,
    CheckCircle2,
    Copy,
    Eye,
    EyeOff,
    ExternalLink,
    Loader2,
    RefreshCw,
    Save,
    Search,
    Trash2,
    Zap,
} from 'lucide-react';
import axios from 'axios';

import { apiV2 } from '../../api';
import type { useStepUpOrchestration } from '../../auth/useStepUpOrchestration';
import { stepUpActionErrorMessage } from '../../auth/withStepUp';
import type { SellerCenterChildProps } from './DigiflazzSellerCenter';

type StepUp = ReturnType<typeof useStepUpOrchestration>;

type SettingsState = {
    configured: boolean;
    ready: boolean;
    username: string;
    apiKey: string;
    apiKeyConfigured: boolean;
    publicBaseUrl: string;
    serverIp: string;
    reportedBalance: number;
    sellerMarginFlat: number;
    allowedIpsText: string;
    callbackEnabled: boolean;
    prepaidEndpointUrl: string;
    prepaidEndpointPath: string;
    digiflazzCallbackUrl: string;
    mappingSummary: { total: number; active: number };
    orderSummary: {
        total: number;
        pending: number;
        callbackPending: number;
        callbackDueRetry: number;
        callbackHighAttempt: number;
    };
    retryQueueHealth: RetryQueueHealth;
};

type RetryQueueHealth = {
    status: 'never' | 'success' | 'partial' | 'failed';
    source: 'admin' | 'scheduler' | 'unknown';
    lastRunAt?: string | null;
    processed: number;
    successCount: number;
    failedCount: number;
    remainingDue: number;
    lastError?: string;
};

type SchedulerConfig = {
    tokenConfigured: boolean;
    endpointPath: string;
    endpointUrl: string;
    tokenHeader: string;
    recommendedIntervalMinutes: number;
    maxLimit: number;
    exampleLimit: number;
};

type MappingItem = {
    _id: string;
    name: string;
    code: string;
    brand: string;
    category: string;
    status: boolean;
    vendor?: { name?: string; sku?: string };
    costPrice?: number;
    recommendedPrice?: number;
    mapping?: {
        id?: string | null;
        pulsaCode?: string;
        price?: number;
        sellerMarginFlat?: number;
        effectiveMarginFlat?: number;
        isActive?: boolean;
        lastSyncStatus?: 'never' | 'success' | 'failed';
        lastSyncRc?: string;
        lastSyncMessage?: string;
        lastSyncAt?: string | null;
    };
};

type LogItem = {
    id: string;
    timestamp: string;
    event: string;
    refId: string;
    status: string;
    message: string;
    delivered: boolean;
};

type OrderItem = {
    id: string;
    refId: string;
    trId: string;
    pulsaCode: string;
    target: string;
    price: number;
    status: 'pending' | 'success' | 'failed';
    rc: string;
    message: string;
    sn: string;
    vendorTrxId: string;
    callbackRequired: boolean;
    callbackAttemptCount: number;
    callbackDeliveredAt?: string | null;
    callbackLastAttemptAt?: string | null;
    callbackNextRetryAt?: string | null;
    callbackLastStatusCode?: number | null;
    callbackLastMessage?: string;
    requestIp?: string;
    createdAt: string;
    updatedAt: string;
    product?: { _id: string; name: string; code: string; brand: string; vendorName: string; vendorSku: string } | null;
};

type MappingEditorState = { pulsaCode: string; sellerMarginFlat: string; isActive: boolean; syncNow: boolean };

const currencyFormatter = new Intl.NumberFormat('id-ID');
const DEFAULT_DIGIFLAZZ_CALLBACK_URL = 'https://api.digiflazz.com/v1/seller/callback';

const defaultRetryQueueHealth: RetryQueueHealth = {
    status: 'never',
    source: 'unknown',
    lastRunAt: null,
    processed: 0,
    successCount: 0,
    failedCount: 0,
    remainingDue: 0,
    lastError: '',
};

const defaultSchedulerConfig: SchedulerConfig = {
    tokenConfigured: false,
    endpointPath: '/api/v2/digiflazz-seller/orders/process-callback-retries/scheduler',
    endpointUrl: '',
    tokenHeader: 'X-Scheduler-Token',
    recommendedIntervalMinutes: 1,
    maxLimit: 50,
    exampleLimit: 20,
};

const defaultSettingsState: SettingsState = {
    configured: false,
    ready: false,
    username: '',
    apiKey: '',
    apiKeyConfigured: false,
    publicBaseUrl: '',
    serverIp: '',
    reportedBalance: 0,
    sellerMarginFlat: 0,
    allowedIpsText: '52.74.250.133',
    callbackEnabled: true,
    prepaidEndpointUrl: '',
    prepaidEndpointPath: '',
    digiflazzCallbackUrl: DEFAULT_DIGIFLAZZ_CALLBACK_URL,
    mappingSummary: { total: 0, active: 0 },
    orderSummary: { total: 0, pending: 0, callbackPending: 0, callbackDueRetry: 0, callbackHighAttempt: 0 },
    retryQueueHealth: defaultRetryQueueHealth,
};

const formatDateTime = (value?: string | null) => {
    if (!value) return '-';
    return new Date(value).toLocaleString('id-ID');
};

const normalizePulsaCode = (value: string) => value.trim().toLowerCase().replace(/\s+/g, '-');

const getErrorMessage = (error: unknown, fallback: string) => {
    if (axios.isAxiosError(error)) {
        const message = error.response?.data?.message;
        if (typeof message === 'string' && message.trim()) return message;
    }
    if (error instanceof Error && error.message.trim()) return error.message;
    return fallback;
};

type ChannelProps = SellerCenterChildProps & { stepUp: StepUp };

export default function DigiflazzSellerChannel({
    section,
    refreshRevision,
    onMutationComplete,
    stepUp,
}: ChannelProps) {
    const [showApiKey, setShowApiKey] = useState(false);
    const [settings, setSettings] = useState<SettingsState>(defaultSettingsState);
    const [loadingSettings, setLoadingSettings] = useState(true);
    const [savingSettings, setSavingSettings] = useState(false);
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

    const [mappingLoading, setMappingLoading] = useState(false);
    const [mappings, setMappings] = useState<MappingItem[]>([]);
    const [mappingSearch, setMappingSearch] = useState('');
    const [mappingFilter, setMappingFilter] = useState<'all' | 'mapped' | 'unmapped'>('all');
    const [mappingPage, setMappingPage] = useState(1);
    const [mappingMeta, setMappingMeta] = useState({ page: 1, limit: 20, total: 0, totalPages: 1 });
    const [mappingSummary, setMappingSummary] = useState({ totalProducts: 0, mappedProducts: 0, activeMappings: 0 });
    const [syncingAll, setSyncingAll] = useState(false);

    const [selectedMappingItem, setSelectedMappingItem] = useState<MappingItem | null>(null);
    const [mappingEditor, setMappingEditor] = useState<MappingEditorState>({ pulsaCode: '', sellerMarginFlat: '', isActive: true, syncNow: true });
    const [savingMapping, setSavingMapping] = useState(false);
    const [deletingMapping, setDeletingMapping] = useState(false);

    const [logs, setLogs] = useState<LogItem[]>([]);
    const [orders, setOrders] = useState<OrderItem[]>([]);
    const [logsLoading, setLogsLoading] = useState(false);
    const [ordersLoading, setOrdersLoading] = useState(false);
    const [retryingCallbackId, setRetryingCallbackId] = useState<string | null>(null);
    const [retryingBulkCallbacks, setRetryingBulkCallbacks] = useState(false);
    const [processingDueRetries, setProcessingDueRetries] = useState(false);
    const [schedulerConfig, setSchedulerConfig] = useState<SchedulerConfig>(defaultSchedulerConfig);

    const fetchSettings = useCallback(async () => {
        try {
            setLoadingSettings(true);
            const response = await apiV2.get('/digiflazz-seller/settings');
            const data = response.data || {};
            setSettings({
                configured: Boolean(data.configured),
                ready: Boolean(data.ready),
                username: data.username || '',
                apiKey: '',
                apiKeyConfigured: Boolean(data.apiKeyConfigured),
                publicBaseUrl: data.publicBaseUrl || '',
                serverIp: data.serverIp || '',
                reportedBalance: Number(data.reportedBalance || 0),
                sellerMarginFlat: Number(data.sellerMarginFlat || 0),
                allowedIpsText: Array.isArray(data.allowedIps) ? data.allowedIps.join(', ') : '52.74.250.133',
                callbackEnabled: data.callbackEnabled !== false,
                prepaidEndpointUrl: data.prepaidEndpointUrl || '',
                prepaidEndpointPath: data.prepaidEndpointPath || '/api/v2/digiflazz-seller/prepaid',
                digiflazzCallbackUrl: data.digiflazzCallbackUrl || DEFAULT_DIGIFLAZZ_CALLBACK_URL,
                mappingSummary: {
                    total: Number(data.mappingSummary?.total || 0),
                    active: Number(data.mappingSummary?.active || 0),
                },
                orderSummary: {
                    total: Number(data.orderSummary?.total || 0),
                    pending: Number(data.orderSummary?.pending || 0),
                    callbackPending: Number(data.orderSummary?.callbackPending || 0),
                    callbackDueRetry: Number(data.orderSummary?.callbackDueRetry || 0),
                    callbackHighAttempt: Number(data.orderSummary?.callbackHighAttempt || 0),
                },
                retryQueueHealth: { ...defaultRetryQueueHealth, ...(data.retryQueueHealth || {}) },
            });
        } catch (error) {
            console.error('Failed to fetch Digiflazz Seller settings:', error);
            setMessage({ type: 'error', text: 'Gagal memuat konfigurasi Digiflazz Seller' });
        } finally {
            setLoadingSettings(false);
        }
    }, []);

    const fetchMappings = useCallback(
        async (searchValue?: string) => {
            try {
                setMappingLoading(true);
                const params = new URLSearchParams();
                params.append('page', String(mappingPage));
                params.append('limit', '20');
                params.append('mapped', mappingFilter);
                const nextSearch = (searchValue ?? mappingSearch).trim();
                if (nextSearch) params.append('search', nextSearch);

                const response = await apiV2.get(`/digiflazz-seller/mappings?${params.toString()}`);
                setMappings(response.data.items || []);
                setMappingMeta(response.data.meta || { page: 1, limit: 20, total: 0, totalPages: 1 });
                setMappingSummary(response.data.summary || { totalProducts: 0, mappedProducts: 0, activeMappings: 0 });
            } catch (error) {
                console.error('Failed to fetch Digiflazz Seller mappings:', error);
                setMessage({ type: 'error', text: 'Gagal memuat daftar mapping produk' });
            } finally {
                setMappingLoading(false);
            }
        },
        [mappingFilter, mappingPage, mappingSearch],
    );

    const fetchLogs = useCallback(async () => {
        try {
            setLogsLoading(true);
            const response = await apiV2.get('/digiflazz-seller/logs');
            setLogs(response.data || []);
        } catch (error) {
            console.error('Failed to fetch Digiflazz Seller logs:', error);
            setMessage({ type: 'error', text: 'Gagal memuat log webhook Digiflazz Seller' });
        } finally {
            setLogsLoading(false);
        }
    }, []);

    const fetchOrders = useCallback(async () => {
        try {
            setOrdersLoading(true);
            const response = await apiV2.get('/digiflazz-seller/orders');
            setOrders(response.data || []);
        } catch (error) {
            console.error('Failed to fetch Digiflazz Seller orders:', error);
            setMessage({ type: 'error', text: 'Gagal memuat order Digiflazz Seller' });
        } finally {
            setOrdersLoading(false);
        }
    }, []);

    const fetchSchedulerConfig = useCallback(async () => {
        try {
            const response = await apiV2.get('/digiflazz-seller/orders/process-callback-retries/scheduler/config');
            setSchedulerConfig({ ...defaultSchedulerConfig, ...(response.data || {}) });
        } catch (error) {
            console.error('Failed to fetch Digiflazz Seller scheduler config:', error);
        }
    }, []);

    useEffect(() => {
        if (section === 'settings') void fetchSettings();
    }, [section, refreshRevision, fetchSettings]);

    useEffect(() => {
        if (section === 'mappings') void fetchMappings();
    }, [section, refreshRevision, mappingPage, mappingFilter, fetchMappings]);

    useEffect(() => {
        if (section === 'orders') {
            void fetchLogs();
            void fetchOrders();
            void fetchSchedulerConfig();
            void fetchSettings();
        }
    }, [section, refreshRevision, fetchLogs, fetchOrders, fetchSchedulerConfig, fetchSettings]);

    useEffect(() => {
        if (!message) return;
        const timer = window.setTimeout(() => setMessage(null), 4500);
        return () => window.clearTimeout(timer);
    }, [message]);

    const derivedEndpointPreview = useMemo(() => {
        if (settings.prepaidEndpointUrl) return settings.prepaidEndpointUrl;
        const base = settings.publicBaseUrl.trim() || window.location.origin;
        return `${base.replace(/\/+$/, '')}${settings.prepaidEndpointPath || '/api/v2/digiflazz-seller/prepaid'}`;
    }, [settings.prepaidEndpointPath, settings.prepaidEndpointUrl, settings.publicBaseUrl]);

    const isHttpsEndpointPreview = derivedEndpointPreview.startsWith('https://');
    const usesDefaultDigiflazzCallbackUrl = settings.digiflazzCallbackUrl.trim() === DEFAULT_DIGIFLAZZ_CALLBACK_URL;
    const schedulerEndpoint = schedulerConfig.endpointUrl || `${window.location.origin}${schedulerConfig.endpointPath}`;
    const schedulerCurlCommand = `curl -X POST "${schedulerEndpoint}" \\
  -H "${schedulerConfig.tokenHeader}: $DIGIFLAZZ_SELLER_RETRY_QUEUE_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"limit":${schedulerConfig.exampleLimit}}'`;
    const schedulerCrontabCommand = `* * * * * curl -fsS -X POST "${schedulerEndpoint}" -H "${schedulerConfig.tokenHeader}: $DIGIFLAZZ_SELLER_RETRY_QUEUE_TOKEN" -H "Content-Type: application/json" -d '{"limit":${schedulerConfig.exampleLimit}}' >/dev/null 2>&1`;

    const selectedMappingId = selectedMappingItem?.mapping?.id ? String(selectedMappingItem.mapping.id) : '';
    const selectedEffectiveMargin = selectedMappingItem?.mapping?.effectiveMarginFlat
        ?? (selectedMappingItem?.mapping?.sellerMarginFlat ?? settings.sellerMarginFlat);
    const selectedEffectivePrice = selectedMappingItem
        ? Number(selectedMappingItem.mapping?.price ?? selectedMappingItem.recommendedPrice ?? 0)
        : 0;

    const handleSaveSettings = async (event: React.FormEvent) => {
        event.preventDefault();
        if (!settings.username.trim()) {
            setMessage({ type: 'error', text: 'Username Digiflazz Seller wajib diisi' });
            return;
        }
        if (!settings.configured && !settings.apiKey.trim()) {
            setMessage({ type: 'error', text: 'API Key wajib diisi untuk setup awal Digiflazz Seller' });
            return;
        }
        try {
            setSavingSettings(true);
            const settingsPayload = {
                username: settings.username.trim(),
                apiKey: settings.apiKey.trim() || undefined,
                publicBaseUrl: settings.publicBaseUrl.trim(),
                digiflazzCallbackUrl: settings.digiflazzCallbackUrl.trim(),
                serverIp: settings.serverIp.trim(),
                reportedBalance: Number(settings.reportedBalance || 0),
                sellerMarginFlat: Number(settings.sellerMarginFlat || 0),
                allowedIps: settings.allowedIpsText.split(',').map((item) => item.trim()).filter(Boolean),
                callbackEnabled: settings.callbackEnabled,
            };
            await stepUp.run('integrations.credentials', (config) =>
                apiV2.post('/digiflazz-seller/settings', settingsPayload, config as never),
            );
            setMessage({ type: 'success', text: 'Konfigurasi Digiflazz Seller berhasil disimpan' });
            await fetchSettings();
            onMutationComplete();
        } catch (error) {
            const text = stepUpActionErrorMessage(error, 'Gagal menyimpan konfigurasi Digiflazz Seller');
            if (text) setMessage({ type: 'error', text });
        } finally {
            setSavingSettings(false);
        }
    };

    const openMappingEditor = (item: MappingItem) => {
        setSelectedMappingItem(item);
        setMappingEditor({
            pulsaCode: item.mapping?.pulsaCode || normalizePulsaCode(item.code || item.name || ''),
            sellerMarginFlat: item.mapping?.sellerMarginFlat !== undefined && item.mapping?.sellerMarginFlat !== null
                ? String(item.mapping.sellerMarginFlat)
                : '',
            isActive: item.mapping?.isActive ?? true,
            syncNow: true,
        });
    };

    const closeMappingEditor = () => {
        setSelectedMappingItem(null);
        setMappingEditor({ pulsaCode: '', sellerMarginFlat: '', isActive: true, syncNow: true });
    };

    const handleSaveMapping = async (event: React.FormEvent) => {
        event.preventDefault();
        if (!selectedMappingItem) return;
        if (!mappingEditor.pulsaCode.trim()) {
            setMessage({ type: 'error', text: 'Pulsa code wajib diisi' });
            return;
        }
        try {
            setSavingMapping(true);
            await apiV2.post('/digiflazz-seller/mappings', {
                productId: selectedMappingItem._id,
                pulsaCode: normalizePulsaCode(mappingEditor.pulsaCode),
                sellerMarginFlat: mappingEditor.sellerMarginFlat.trim() === ''
                    ? undefined
                    : Number(mappingEditor.sellerMarginFlat),
                isActive: mappingEditor.isActive,
                syncNow: mappingEditor.syncNow,
            });
            setMessage({ type: 'success', text: 'Mapping Digiflazz Seller berhasil disimpan' });
            closeMappingEditor();
            await Promise.all([fetchMappings(), fetchSettings()]);
            onMutationComplete();
        } catch (error) {
            setMessage({ type: 'error', text: getErrorMessage(error, 'Gagal menyimpan mapping') });
        } finally {
            setSavingMapping(false);
        }
    };

    const handleDeleteMapping = async () => {
        if (!selectedMappingId) return;
        if (!window.confirm('Hapus mapping Digiflazz Seller untuk produk ini?')) return;
        try {
            setDeletingMapping(true);
            await apiV2.delete(`/digiflazz-seller/mappings/${selectedMappingId}`);
            setMessage({ type: 'success', text: 'Mapping Digiflazz Seller berhasil dihapus' });
            closeMappingEditor();
            await Promise.all([fetchMappings(), fetchSettings()]);
            onMutationComplete();
        } catch (error) {
            setMessage({ type: 'error', text: getErrorMessage(error, 'Gagal menghapus mapping') });
        } finally {
            setDeletingMapping(false);
        }
    };

    const handleSyncMapping = async (mappingId?: string | null) => {
        if (!mappingId) return;
        try {
            await apiV2.post(`/digiflazz-seller/mappings/${mappingId}/sync`);
            setMessage({ type: 'success', text: 'Mapping berhasil disinkronkan ke Digiflazz Seller' });
            await fetchMappings();
            onMutationComplete();
        } catch (error) {
            setMessage({ type: 'error', text: getErrorMessage(error, 'Gagal sinkronisasi mapping') });
        }
    };

    const handleSyncAllMappings = async () => {
        try {
            setSyncingAll(true);
            const response = await apiV2.post('/digiflazz-seller/mappings/sync', { limit: 50 });
            const data = response.data || {};
            setMessage({
                type: 'success',
                text: `Sinkronisasi selesai. ${data.successCount || 0} sukses, ${data.failedCount || 0} gagal.`,
            });
            await fetchMappings();
            onMutationComplete();
        } catch (error) {
            setMessage({ type: 'error', text: getErrorMessage(error, 'Gagal sinkronisasi semua mapping') });
        } finally {
            setSyncingAll(false);
        }
    };

    const handleRetryCallback = async (orderId: string) => {
        try {
            setRetryingCallbackId(orderId);
            const response = await apiV2.post(`/digiflazz-seller/orders/${orderId}/retry-callback`);
            setMessage({
                type: response.data?.success ? 'success' : 'error',
                text: response.data?.message || 'Retry callback selesai',
            });
            await Promise.all([fetchLogs(), fetchOrders(), fetchSettings()]);
            onMutationComplete();
        } catch (error) {
            setMessage({ type: 'error', text: getErrorMessage(error, 'Gagal retry callback') });
        } finally {
            setRetryingCallbackId(null);
        }
    };

    const handleRetryPendingCallbacks = async () => {
        try {
            setRetryingBulkCallbacks(true);
            const response = await apiV2.post('/digiflazz-seller/orders/retry-callbacks', { limit: 25 });
            const data = response.data || {};
            setMessage({
                type: data.failedCount > 0 ? 'error' : 'success',
                text: `Retry callback selesai. ${data.successCount || 0} terkirim, ${data.failedCount || 0} gagal, ${data.processed || 0} diproses.`,
            });
            await Promise.all([fetchLogs(), fetchOrders(), fetchSettings()]);
            onMutationComplete();
        } catch (error) {
            setMessage({ type: 'error', text: getErrorMessage(error, 'Gagal retry callback pending') });
        } finally {
            setRetryingBulkCallbacks(false);
        }
    };

    const handleProcessDueRetries = async () => {
        try {
            setProcessingDueRetries(true);
            const response = await apiV2.post('/digiflazz-seller/orders/process-callback-retries', { limit: 20 });
            const data = response.data || {};
            setMessage({
                type: data.failedCount > 0 ? 'error' : 'success',
                text: `Queue retry diproses. ${data.successCount || 0} terkirim, ${data.failedCount || 0} gagal, ${data.remainingDue || 0} masih due.`,
            });
            await Promise.all([fetchLogs(), fetchOrders(), fetchSettings()]);
            onMutationComplete();
        } catch (error) {
            setMessage({ type: 'error', text: getErrorMessage(error, 'Gagal memproses queue retry callback') });
        } finally {
            setProcessingDueRetries(false);
        }
    };

    const handleSearchMappings = (event: React.FormEvent) => {
        event.preventDefault();
        if (mappingPage !== 1) {
            setMappingPage(1);
            return;
        }
        void fetchMappings();
    };

    const copyToClipboard = async (value: string, successText: string) => {
        try {
            await navigator.clipboard.writeText(value);
            setMessage({ type: 'success', text: successText });
        } catch (error) {
            console.error('Failed to copy text:', error);
            setMessage({ type: 'error', text: 'Gagal menyalin ke clipboard' });
        }
    };

    return (
        <div className="space-y-5">
            {message && (
                <div className={`rounded-xl border px-4 py-3 text-sm ${message.type === 'error' ? 'ui-danger-chip' : 'ui-success-chip'}`}>
                    {message.text}
                </div>
            )}

            {section === 'settings' && (
                <SettingsSection
                    settings={settings}
                    setSettings={setSettings}
                    loadingSettings={loadingSettings}
                    savingSettings={savingSettings}
                    showApiKey={showApiKey}
                    setShowApiKey={setShowApiKey}
                    handleSaveSettings={handleSaveSettings}
                    derivedEndpointPreview={derivedEndpointPreview}
                    isHttpsEndpointPreview={isHttpsEndpointPreview}
                    usesDefaultDigiflazzCallbackUrl={usesDefaultDigiflazzCallbackUrl}
                    copyToClipboard={copyToClipboard}
                />
            )}

            {section === 'mappings' && (
                <MappingsSection
                    mappingLoading={mappingLoading}
                    mappings={mappings}
                    mappingSearch={mappingSearch}
                    setMappingSearch={setMappingSearch}
                    mappingFilter={mappingFilter}
                    setMappingFilter={setMappingFilter}
                    setMappingPage={setMappingPage}
                    mappingMeta={mappingMeta}
                    mappingSummary={mappingSummary}
                    syncingAll={syncingAll}
                    handleSyncAllMappings={handleSyncAllMappings}
                    handleSearchMappings={handleSearchMappings}
                    handleSyncMapping={handleSyncMapping}
                    openMappingEditor={openMappingEditor}
                    sellerMarginFlat={settings.sellerMarginFlat}
                />
            )}

            {section === 'orders' && (
                <OrdersSection
                    logs={logs}
                    logsLoading={logsLoading}
                    orders={orders}
                    ordersLoading={ordersLoading}
                    settings={settings}
                    schedulerConfig={schedulerConfig}
                    schedulerCurlCommand={schedulerCurlCommand}
                    schedulerCrontabCommand={schedulerCrontabCommand}
                    retryingCallbackId={retryingCallbackId}
                    retryingBulkCallbacks={retryingBulkCallbacks}
                    processingDueRetries={processingDueRetries}
                    handleRetryCallback={handleRetryCallback}
                    handleRetryPendingCallbacks={handleRetryPendingCallbacks}
                    handleProcessDueRetries={handleProcessDueRetries}
                    copyToClipboard={copyToClipboard}
                />
            )}

            {selectedMappingItem && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
                    <div className="w-full max-w-2xl rounded-2xl border ui-border ui-panel p-5 shadow-2xl">
                        <div className="flex items-start justify-between gap-4">
                            <div>
                                <h2 className="text-lg font-bold ui-text">{selectedMappingItem.mapping?.id ? 'Edit Mapping Digiflazz Seller' : 'Buat Mapping Digiflazz Seller'}</h2>
                                <p className="text-sm ui-text-muted">{selectedMappingItem.name} • {selectedMappingItem.code}</p>
                            </div>
                            <button
                                onClick={closeMappingEditor}
                                className="rounded-lg border px-3 py-2 text-xs font-semibold ui-muted-action hover:border-[var(--ui-accent)]"
                            >
                                Tutup
                            </button>
                        </div>

                        <div className="mt-4 grid gap-4 rounded-xl border ui-border ui-panel-muted p-4 text-sm ui-text-muted md:grid-cols-2">
                            <div>
                                <div className="text-xs uppercase tracking-[0.18em] ui-text-muted">Supplier Vendor</div>
                                <div className="mt-1 ui-text">{selectedMappingItem.vendor?.name || '-'}</div>
                                <div className="text-xs ui-text-muted">{selectedMappingItem.vendor?.sku || selectedMappingItem.code}</div>
                            </div>
                            <div>
                                <div className="text-xs uppercase tracking-[0.18em] ui-text-muted">Modal dan Harga Rekomendasi</div>
                                <div className="mt-1 ui-text">Modal: Rp{currencyFormatter.format(Number(selectedMappingItem.costPrice || 0))}</div>
                                <div className="mt-1 ui-warning-text">Harga seller aktif: Rp{currencyFormatter.format(selectedEffectivePrice)}</div>
                                <div className="mt-1 ui-text-muted">Margin aktif: Rp{currencyFormatter.format(Number(selectedEffectiveMargin || 0))}</div>
                            </div>
                        </div>

                        <form onSubmit={handleSaveMapping} className="mt-4 space-y-4">
                            <div className="grid gap-4 md:grid-cols-2">
                                <label className="space-y-2">
                                    <span className="text-sm font-medium ui-text">Pulsa Code Digiflazz</span>
                                    <input
                                        value={mappingEditor.pulsaCode}
                                        onChange={(event) => setMappingEditor((prev) => ({ ...prev, pulsaCode: normalizePulsaCode(event.target.value) }))}
                                        className="w-full rounded-xl border px-4 py-3 text-sm ui-field"
                                        placeholder="kodeproduk"
                                    />
                                </label>
                                <label className="space-y-2">
                                    <span className="text-sm font-medium ui-text">Margin Custom Produk</span>
                                    <input
                                        type="number"
                                        min={0}
                                        value={mappingEditor.sellerMarginFlat}
                                        onChange={(event) => setMappingEditor((prev) => ({ ...prev, sellerMarginFlat: event.target.value }))}
                                        className="w-full rounded-xl border px-4 py-3 text-sm ui-field"
                                        placeholder={`Kosong = global ${settings.sellerMarginFlat}`}
                                    />
                                    <p className="text-xs ui-text-muted">Kosongkan jika produk ini harus ikut margin global seller.</p>
                                </label>
                            </div>

                            <div className="rounded-xl border ui-border ui-panel-muted px-4 py-3 text-sm ui-text">
                                Harga seller yang akan disimpan:
                                <span className="ml-2 font-semibold ui-warning-text">
                                    Rp{currencyFormatter.format(
                                        Math.max(
                                            0,
                                            Number(selectedMappingItem.costPrice || 0)
                                            + Number(mappingEditor.sellerMarginFlat.trim() === '' ? settings.sellerMarginFlat : Number(mappingEditor.sellerMarginFlat)),
                                        ),
                                    )}
                                </span>
                            </div>

                            <label className="flex items-center gap-3 rounded-xl border ui-border ui-panel-muted px-4 py-3 text-sm ui-text">
                                <input
                                    type="checkbox"
                                    checked={mappingEditor.isActive}
                                    onChange={(event) => setMappingEditor((prev) => ({ ...prev, isActive: event.target.checked }))}
                                    className="h-4 w-4 rounded border-[var(--ui-border)] bg-[var(--ui-card-bg)] text-[var(--ui-accent)]"
                                />
                                Mapping aktif dan bisa dijual lewat Digiflazz Seller
                            </label>

                            <label className="flex items-center gap-3 rounded-xl border ui-border ui-panel-muted px-4 py-3 text-sm ui-text">
                                <input
                                    type="checkbox"
                                    checked={mappingEditor.syncNow}
                                    onChange={(event) => setMappingEditor((prev) => ({ ...prev, syncNow: event.target.checked }))}
                                    className="h-4 w-4 rounded border-[var(--ui-border)] bg-[var(--ui-card-bg)] text-[var(--ui-accent)]"
                                />
                                Setelah simpan, langsung sync harga dan status ke panel Seller Digiflazz
                            </label>

                            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                <div className="text-xs ui-text-muted">
                                    Digiflazz Seller prabayar hanya membawa satu field target `hp`. IRS memakai mapping yang sama.
                                </div>
                                <div className="flex flex-wrap gap-2">
                                    {selectedMappingId && (
                                        <button
                                            type="button"
                                            onClick={handleDeleteMapping}
                                            disabled={deletingMapping}
                                            className="inline-flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-semibold ui-danger-action disabled:cursor-not-allowed disabled:opacity-60"
                                        >
                                            {deletingMapping ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                                            Hapus
                                        </button>
                                    )}
                                    <button
                                        type="submit"
                                        disabled={savingMapping}
                                        className="inline-flex items-center gap-2 rounded-xl ui-accent-solid px-4 py-2.5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60"
                                    >
                                        {savingMapping ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                                        {savingMapping ? 'Menyimpan...' : 'Simpan Mapping'}
                                    </button>
                                </div>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}

const SettingsSection = ({
    settings,
    setSettings,
    loadingSettings,
    savingSettings,
    showApiKey,
    setShowApiKey,
    handleSaveSettings,
    derivedEndpointPreview,
    isHttpsEndpointPreview,
    usesDefaultDigiflazzCallbackUrl,
    copyToClipboard,
}: {
    settings: SettingsState;
    setSettings: React.Dispatch<React.SetStateAction<SettingsState>>;
    loadingSettings: boolean;
    savingSettings: boolean;
    showApiKey: boolean;
    setShowApiKey: React.Dispatch<React.SetStateAction<boolean>>;
    handleSaveSettings: (event: React.FormEvent) => Promise<void>;
    derivedEndpointPreview: string;
    isHttpsEndpointPreview: boolean;
    usesDefaultDigiflazzCallbackUrl: boolean;
    copyToClipboard: (value: string, successText: string) => Promise<void>;
}) => (
    <div className="space-y-5">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-xl border ui-border ui-panel-muted p-5">
                <div className="text-xs uppercase tracking-[0.18em] ui-accent-text">Status Setup</div>
                <div className={`mt-2 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm font-semibold ${settings.ready ? 'ui-success-chip' : settings.configured ? 'ui-warning-chip' : 'ui-danger-chip'}`}>
                    {settings.ready ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
                    {settings.ready ? 'Siap dipakai' : settings.configured ? 'Perlu penyelesaian' : 'Belum dikonfigurasi'}
                </div>
                <p className="mt-3 text-sm ui-text-muted">Lengkapi kredensial, base URL publik, dan minimal satu mapping aktif.</p>
            </div>
            <div className="rounded-xl border ui-border ui-panel-muted p-5">
                <div className="text-xs uppercase tracking-[0.18em] ui-accent-text">Mapping Aktif</div>
                <div className="mt-2 text-3xl font-black ui-text">{settings.mappingSummary.active}</div>
                <p className="mt-1 text-sm ui-text-muted">dari {settings.mappingSummary.total} produk yang terhubung ke Digiflazz Seller.</p>
            </div>
            <div className="rounded-xl border ui-border ui-panel-muted p-5">
                <div className="text-xs uppercase tracking-[0.18em] ui-accent-text">Order Pending</div>
                <div className="mt-2 text-3xl font-black ui-text">{settings.orderSummary.pending}</div>
                <p className="mt-1 text-sm ui-text-muted">Order Seller yang masih menunggu update final dari supplier.</p>
            </div>
            <div className="rounded-xl border ui-border ui-panel-muted p-5">
                <div className="text-xs uppercase tracking-[0.18em] ui-accent-text">Callback Tertunda</div>
                <div className="mt-2 text-3xl font-black ui-text">{settings.orderSummary.callbackPending}</div>
                <p className="mt-1 text-sm ui-text-muted">Final status yang masih perlu atau gagal dikirim ke callback Digiflazz.</p>
            </div>
        </div>

        <div className="grid gap-5 xl:grid-cols-[1.4fr_1fr]">
            <form onSubmit={handleSaveSettings} className="space-y-4 rounded-2xl border ui-border ui-panel-muted p-5">
                <div className="flex items-center justify-between">
                    <div>
                        <h2 className="text-lg font-bold ui-text">Konfigurasi Seller</h2>
                        <p className="text-sm ui-text-muted">Isi kredensial yang sama dengan Pengaturan Koneksi API Seller Digiflazz.</p>
                    </div>
                    {loadingSettings && <Loader2 className="h-4 w-4 animate-spin ui-warning-text" />}
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                    <label className="space-y-2">
                        <span className="text-sm font-medium ui-text">Username Digiflazz Seller</span>
                        <input
                            value={settings.username}
                            onChange={(event) => setSettings((prev) => ({ ...prev, username: event.target.value }))}
                            className="w-full rounded-xl border px-4 py-3 text-sm ui-field"
                            placeholder="username_seller"
                        />
                    </label>
                    <label className="space-y-2">
                        <span className="text-sm font-medium ui-text">API Key</span>
                        <div className="relative">
                            <input
                                type={showApiKey ? 'text' : 'password'}
                                value={settings.apiKey}
                                onChange={(event) => setSettings((prev) => ({ ...prev, apiKey: event.target.value }))}
                                className="w-full rounded-xl border px-4 py-3 pr-12 text-sm ui-field"
                                placeholder={settings.apiKeyConfigured ? 'API key tersimpan — isi untuk mengganti' : 'Masukkan API key'}
                                autoComplete="new-password"
                            />
                            <button
                                type="button"
                                onClick={() => setShowApiKey((prev) => !prev)}
                                className="absolute right-3 top-1/2 -translate-y-1/2 ui-text-muted transition-colors hover:text-[var(--ui-text)]"
                                aria-label={showApiKey ? 'Sembunyikan API key' : 'Tampilkan API key'}
                            >
                                {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                            </button>
                        </div>
                        {settings.apiKeyConfigured && (
                            <p className="text-xs ui-text-muted">API key sudah tersimpan. Kosongkan field jika tidak ingin mengubahnya.</p>
                        )}
                    </label>
                    <label className="space-y-2 md:col-span-2">
                        <span className="text-sm font-medium ui-text">Public Base URL</span>
                        <input
                            type="url"
                            value={settings.publicBaseUrl}
                            onChange={(event) => setSettings((prev) => ({ ...prev, publicBaseUrl: event.target.value }))}
                            className="w-full rounded-xl border px-4 py-3 text-sm ui-field"
                            placeholder="https://domain-anda.com"
                        />
                        <p className="text-xs ui-text-muted">Dipakai untuk membentuk URL endpoint prabayar yang Anda daftarkan di panel Seller Digiflazz.</p>
                    </label>
                    <label className="space-y-2 md:col-span-2">
                        <span className="text-sm font-medium ui-text">Report / Callback URL Digiflazz</span>
                        <input
                            type="url"
                            value={settings.digiflazzCallbackUrl}
                            onChange={(event) => setSettings((prev) => ({ ...prev, digiflazzCallbackUrl: event.target.value }))}
                            className="w-full rounded-xl border px-4 py-3 text-sm ui-field"
                            placeholder="https://api.digiflazz.com/v1/seller/callback/gqZRVo"
                        />
                        <p className="text-xs ui-text-muted">Isi persis URL report/callback yang muncul di panel Seller Digiflazz. Jika panel memberi URL unik dengan suffix token, gunakan URL itu, bukan base URL umum.</p>
                    </label>
                    <label className="space-y-2">
                        <span className="text-sm font-medium ui-text">IP Server Outbound</span>
                        <input
                            value={settings.serverIp}
                            onChange={(event) => setSettings((prev) => ({ ...prev, serverIp: event.target.value }))}
                            className="w-full rounded-xl border px-4 py-3 text-sm ui-field"
                            placeholder="203.0.113.10"
                        />
                        <p className="text-xs ui-text-muted">Hanya untuk catatan operasional Anda saat mengisi form Seller Digiflazz.</p>
                    </label>
                    <label className="space-y-2">
                        <span className="text-sm font-medium ui-text">Reported Balance</span>
                        <input
                            type="number"
                            min={0}
                            value={settings.reportedBalance}
                            onChange={(event) => setSettings((prev) => ({ ...prev, reportedBalance: Number(event.target.value || 0) }))}
                            className="w-full rounded-xl border px-4 py-3 text-sm ui-field"
                            placeholder="0"
                        />
                        <p className="text-xs ui-text-muted">Nilai ini dikirim ke field `balance` pada response dan callback seller.</p>
                    </label>
                    <label className="space-y-2">
                        <span className="text-sm font-medium ui-text">Margin Seller Nominal</span>
                        <input
                            type="number"
                            min={0}
                            value={settings.sellerMarginFlat}
                            onChange={(event) => setSettings((prev) => ({ ...prev, sellerMarginFlat: Number(event.target.value || 0) }))}
                            className="w-full rounded-xl border px-4 py-3 text-sm ui-field"
                            placeholder="0"
                        />
                        <p className="text-xs ui-text-muted">Harga default mapping seller = `costPrice + margin seller`. Tidak ikut harga publik basic, gold, atau platinum.</p>
                    </label>
                    <label className="space-y-2 md:col-span-2">
                        <span className="text-sm font-medium ui-text">Whitelist IP Inbound Digiflazz</span>
                        <textarea
                            value={settings.allowedIpsText}
                            onChange={(event) => setSettings((prev) => ({ ...prev, allowedIpsText: event.target.value }))}
                            rows={3}
                            className="w-full rounded-xl border px-4 py-3 text-sm ui-field"
                            placeholder="52.74.250.133"
                        />
                        <p className="text-xs ui-text-muted">Pisahkan dengan koma atau baris baru. Hanya alamat IP valid yang akan diterima. Dokumentasi Digiflazz seller menyebut IP `52.74.250.133`.</p>
                    </label>
                </div>

                <label className="flex items-center gap-3 rounded-xl border ui-border ui-panel px-4 py-3 text-sm ui-text">
                    <input
                        type="checkbox"
                        checked={settings.callbackEnabled}
                        onChange={(event) => setSettings((prev) => ({ ...prev, callbackEnabled: event.target.checked }))}
                        className="h-4 w-4 rounded border-[var(--ui-border)] bg-[var(--ui-card-bg)] text-[var(--ui-accent)]"
                    />
                    Callback outbound ke Digiflazz aktif
                </label>

                <div className="flex justify-end">
                    <button
                        type="submit"
                        disabled={savingSettings}
                        className="inline-flex items-center gap-2 rounded-xl ui-accent-solid px-4 py-2.5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        {savingSettings ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                        {savingSettings ? 'Menyimpan...' : 'Simpan Konfigurasi'}
                    </button>
                </div>
            </form>

            <div className="space-y-4 rounded-2xl border ui-border ui-panel-muted p-5">
                <div>
                    <h2 className="text-lg font-bold ui-text">Endpoint Operasional</h2>
                    <p className="text-sm ui-text-muted">Gunakan data ini saat mengisi Pengaturan Koneksi API Seller di Digiflazz.</p>
                </div>

                <div className="space-y-3">
                    <div className="rounded-xl border ui-border ui-panel p-4">
                        <div className="text-xs uppercase tracking-[0.18em] ui-accent-text">End Point URL Prabayar</div>
                        <div className="mt-2 break-all text-sm ui-text">{derivedEndpointPreview}</div>
                        {!isHttpsEndpointPreview && (
                            <div className="mt-3 rounded-lg border px-3 py-2 text-xs ui-warning-chip">
                                Gunakan `https://` di production agar endpoint seller tidak dikirim lewat koneksi plain HTTP.
                            </div>
                        )}
                        <div className="mt-3 flex flex-wrap gap-2">
                            <button
                                type="button"
                                onClick={() => copyToClipboard(derivedEndpointPreview, 'URL prabayar berhasil disalin')}
                                className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold ui-muted-action hover:border-[var(--ui-accent)]"
                            >
                                <Copy className="h-3.5 w-3.5" />
                                Copy
                            </button>
                            <a
                                href="https://developer.digiflazz.com/api/seller/persiapan/"
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold ui-muted-action hover:border-[var(--ui-accent)]"
                            >
                                <ExternalLink className="h-3.5 w-3.5" />
                                Docs Persiapan
                            </a>
                        </div>
                    </div>

                    <div className="rounded-xl border ui-border ui-panel p-4">
                        <div className="text-xs uppercase tracking-[0.18em] ui-accent-text">Callback Digiflazz</div>
                        <div className="mt-2 break-all text-sm ui-text">{settings.digiflazzCallbackUrl}</div>
                        <p className="mt-2 text-xs ui-text-muted">Saat order seller yang tadinya pending berubah menjadi sukses/gagal, sistem ini akan mengirim POST ke URL di atas.</p>
                        {usesDefaultDigiflazzCallbackUrl ? (
                            <div className="mt-3 rounded-lg border px-3 py-2 text-xs ui-warning-chip">
                                Saat ini masih memakai URL default global. Jika panel Digiflazz Anda menampilkan URL unik seperti `.../callback/gqZRVo`, ganti field report URL di form settings dengan URL persis dari panel.
                            </div>
                        ) : (
                            <div className="mt-3 rounded-lg border px-3 py-2 text-xs ui-success-chip">
                                Callback memakai URL custom dari panel Digiflazz Seller.
                            </div>
                        )}
                        <div className="mt-3 flex flex-wrap gap-2">
                            <button
                                type="button"
                                onClick={() => copyToClipboard(settings.digiflazzCallbackUrl, 'URL callback Digiflazz berhasil disalin')}
                                className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold ui-muted-action hover:border-[var(--ui-accent)]"
                            >
                                <Copy className="h-3.5 w-3.5" />
                                Copy
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
);

const MappingsSection = ({
    mappingLoading,
    mappings,
    mappingSearch,
    setMappingSearch,
    mappingFilter,
    setMappingFilter,
    setMappingPage,
    mappingMeta,
    mappingSummary,
    syncingAll,
    handleSyncAllMappings,
    handleSearchMappings,
    handleSyncMapping,
    openMappingEditor,
    sellerMarginFlat,
}: {
    mappingLoading: boolean;
    mappings: MappingItem[];
    mappingSearch: string;
    setMappingSearch: React.Dispatch<React.SetStateAction<string>>;
    mappingFilter: 'all' | 'mapped' | 'unmapped';
    setMappingFilter: (value: 'all' | 'mapped' | 'unmapped') => void;
    setMappingPage: React.Dispatch<React.SetStateAction<number>>;
    mappingMeta: { page: number; limit: number; total: number; totalPages: number };
    mappingSummary: { totalProducts: number; mappedProducts: number; activeMappings: number };
    syncingAll: boolean;
    handleSyncAllMappings: () => Promise<void>;
    handleSearchMappings: (event: React.FormEvent) => void;
    handleSyncMapping: (mappingId?: string | null) => Promise<void>;
    openMappingEditor: (item: MappingItem) => void;
    sellerMarginFlat: number;
}) => (
    <div className="space-y-5">
        <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-xl border ui-border ui-panel-muted p-5">
                <div className="text-xs uppercase tracking-[0.18em] ui-accent-text">Total Produk Tersaring</div>
                <div className="mt-2 text-3xl font-black ui-text">{mappingSummary.totalProducts}</div>
            </div>
            <div className="rounded-xl border ui-border ui-panel-muted p-5">
                <div className="text-xs uppercase tracking-[0.18em] ui-accent-text">Sudah Dimapping</div>
                <div className="mt-2 text-3xl font-black ui-text">{mappingSummary.mappedProducts}</div>
            </div>
            <div className="rounded-xl border ui-border ui-panel-muted p-5">
                <div className="text-xs uppercase tracking-[0.18em] ui-accent-text">Mapping Aktif</div>
                <div className="mt-2 text-3xl font-black ui-text">{mappingSummary.activeMappings}</div>
            </div>
        </div>

        <div className="rounded-2xl border ui-border ui-panel-muted p-5">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                <form onSubmit={handleSearchMappings} className="flex flex-col gap-3 md:flex-row md:items-center">
                    <div className="relative">
                        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 ui-text-muted" />
                        <input
                            value={mappingSearch}
                            onChange={(event) => setMappingSearch(event.target.value)}
                            className="w-full rounded-xl border py-3 pl-10 pr-4 text-sm ui-field md:w-80"
                            placeholder="Cari nama, kode, brand, kategori..."
                        />
                    </div>
                    <select
                        value={mappingFilter}
                        onChange={(event) => {
                            setMappingFilter(event.target.value as 'all' | 'mapped' | 'unmapped');
                            setMappingPage(1);
                        }}
                        className="rounded-xl border px-4 py-3 text-sm ui-field"
                    >
                        <option value="all">Semua Produk</option>
                        <option value="mapped">Sudah Dimapping</option>
                        <option value="unmapped">Belum Dimapping</option>
                    </select>
                    <button
                        type="submit"
                        className="rounded-xl border px-4 py-3 text-sm font-semibold ui-muted-action hover:border-[var(--ui-accent)]"
                    >
                        Cari
                    </button>
                </form>

                <div className="flex flex-wrap gap-2">
                    <button
                        onClick={handleSyncAllMappings}
                        disabled={syncingAll}
                        className="inline-flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-semibold ui-warning-action disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        {syncingAll ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
                        Sync Maks. 50 Mapping
                    </button>
                </div>
            </div>

            <div className="mt-4 overflow-x-auto">
                <table className="min-w-full text-sm">
                    <thead>
                        <tr className="border-b ui-border text-left ui-text-muted">
                            <th className="px-4 py-3 font-medium">Produk Lokal</th>
                            <th className="px-4 py-3 font-medium">Supplier</th>
                            <th className="px-4 py-3 font-medium">Pulsa Code</th>
                            <th className="px-4 py-3 font-medium">Harga Seller</th>
                            <th className="px-4 py-3 font-medium">Margin</th>
                            <th className="px-4 py-3 font-medium">Sync</th>
                            <th className="px-4 py-3 font-medium">Aksi</th>
                        </tr>
                    </thead>
                    <tbody>
                        {mappingLoading ? (
                            <tr>
                                <td colSpan={7} className="px-4 py-10 text-center ui-text-muted">Memuat data mapping...</td>
                            </tr>
                        ) : mappings.length === 0 ? (
                            <tr>
                                <td colSpan={7} className="px-4 py-10 text-center ui-text-muted">Tidak ada produk yang cocok dengan filter saat ini.</td>
                            </tr>
                        ) : (
                            mappings.map((item) => {
                                const hasMapping = Boolean(item.mapping?.id);
                                return (
                                    <tr key={item._id} className="border-b ui-border align-top ui-text hover:bg-[var(--ui-card-bg)]">
                                        <td className="px-4 py-4">
                                            <div className="font-semibold ui-text">{item.name}</div>
                                            <div className="mt-1 text-xs ui-text-muted">
                                                <span>{item.code}</span>
                                                <span className="mx-1.5 ui-text-muted">/</span>
                                                <span>{item.brand || '-'}</span>
                                                <span className="mx-1.5 ui-text-muted">/</span>
                                                <span>{item.category || '-'}</span>
                                            </div>
                                            {!item.status && (
                                                <div className="mt-2 inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold ui-danger-chip">Produk lokal nonaktif</div>
                                            )}
                                        </td>
                                        <td className="px-4 py-4 text-xs ui-text-muted">
                                            <div>{item.vendor?.name || '-'}</div>
                                            <div className="mt-1 ui-text-muted">{item.vendor?.sku || item.code}</div>
                                        </td>
                                        <td className="px-4 py-4">
                                            {hasMapping ? (
                                                <div>
                                                    <div className="font-mono ui-warning-text">{item.mapping?.pulsaCode}</div>
                                                    <div className={`mt-2 inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold ${item.mapping?.isActive ? 'ui-success-chip' : 'ui-warning-chip'}`}>
                                                        {item.mapping?.isActive ? 'Aktif' : 'Nonaktif'}
                                                    </div>
                                                </div>
                                            ) : (
                                                <span className="ui-text-muted">Belum ada mapping</span>
                                            )}
                                        </td>
                                        <td className="px-4 py-4">
                                            {hasMapping ? (
                                                <div className="font-semibold ui-text">Rp{currencyFormatter.format(Number(item.mapping?.price || 0))}</div>
                                            ) : (
                                                <div className="space-y-1 text-xs">
                                                    <div className="ui-text-muted">Modal: Rp{currencyFormatter.format(Number(item.costPrice || 0))}</div>
                                                    <div className="ui-warning-text">Rekomendasi seller: Rp{currencyFormatter.format(Number(item.recommendedPrice || 0))}</div>
                                                </div>
                                            )}
                                        </td>
                                        <td className="px-4 py-4 text-xs ui-text-muted">
                                            {hasMapping ? (
                                                <div className="space-y-1">
                                                    <div className="ui-text">
                                                        Rp{currencyFormatter.format(Number(item.mapping?.effectiveMarginFlat ?? sellerMarginFlat))}
                                                    </div>
                                                    <div className="ui-text-muted">
                                                        {item.mapping?.sellerMarginFlat !== undefined && item.mapping?.sellerMarginFlat !== null
                                                            ? 'Custom produk'
                                                            : 'Global seller'}
                                                    </div>
                                                </div>
                                            ) : (
                                                <div className="space-y-1">
                                                    <div className="ui-text">Rp{currencyFormatter.format(Number(sellerMarginFlat || 0))}</div>
                                                    <div className="ui-text-muted">Global seller</div>
                                                </div>
                                            )}
                                        </td>
                                        <td className="px-4 py-4 text-xs ui-text-muted">
                                            {hasMapping ? (
                                                <div className="space-y-1">
                                                    <div className={`inline-flex rounded-full border px-2.5 py-1 font-semibold ${item.mapping?.lastSyncStatus === 'success' ? 'ui-success-chip' : item.mapping?.lastSyncStatus === 'failed' ? 'ui-danger-chip' : 'ui-panel ui-text-muted'}`}>
                                                        {item.mapping?.lastSyncStatus === 'success' ? 'Sync sukses' : item.mapping?.lastSyncStatus === 'failed' ? 'Sync gagal' : 'Belum sync'}
                                                    </div>
                                                    {item.mapping?.lastSyncRc && <div>RC: {item.mapping.lastSyncRc}</div>}
                                                    {item.mapping?.lastSyncMessage && <div className="max-w-[220px] ui-text-muted">{item.mapping.lastSyncMessage}</div>}
                                                </div>
                                            ) : (
                                                <span className="ui-text-muted">Belum pernah sync</span>
                                            )}
                                        </td>
                                        <td className="px-4 py-4">
                                            <div className="flex flex-wrap gap-2">
                                                <button
                                                    onClick={() => openMappingEditor(item)}
                                                    className="rounded-lg border px-3 py-2 text-xs font-semibold ui-muted-action hover:border-[var(--ui-accent)]"
                                                >
                                                    {hasMapping ? 'Edit Mapping' : 'Buat Mapping'}
                                                </button>
                                                {hasMapping && (
                                                    <button
                                                        onClick={() => handleSyncMapping(item.mapping?.id || undefined)}
                                                        className="rounded-lg border px-3 py-2 text-xs font-semibold ui-warning-action"
                                                    >
                                                        Sync
                                                    </button>
                                                )}
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })
                        )}
                    </tbody>
                </table>
            </div>

            <div className="mt-4 flex flex-col gap-3 border-t ui-border pt-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="text-sm ui-text-muted">
                    Halaman {mappingMeta.page} dari {mappingMeta.totalPages} • Total {mappingMeta.total} produk
                </div>
                <div className="flex gap-2">
                    <button
                        disabled={mappingMeta.page <= 1}
                        onClick={() => setMappingPage((prev) => Math.max(prev - 1, 1))}
                        className="rounded-lg border px-3 py-2 text-xs font-semibold ui-muted-action disabled:cursor-not-allowed disabled:opacity-40"
                    >
                        Sebelumnya
                    </button>
                    <button
                        disabled={mappingMeta.page >= mappingMeta.totalPages}
                        onClick={() => setMappingPage((prev) => prev + 1)}
                        className="rounded-lg border px-3 py-2 text-xs font-semibold ui-muted-action disabled:cursor-not-allowed disabled:opacity-40"
                    >
                        Berikutnya
                    </button>
                </div>
            </div>
        </div>
    </div>
);

const OrdersSection = ({
    logs,
    logsLoading,
    orders,
    ordersLoading,
    settings,
    schedulerConfig,
    schedulerCurlCommand,
    schedulerCrontabCommand,
    retryingCallbackId,
    retryingBulkCallbacks,
    processingDueRetries,
    handleRetryCallback,
    handleRetryPendingCallbacks,
    handleProcessDueRetries,
    copyToClipboard,
}: {
    logs: LogItem[];
    logsLoading: boolean;
    orders: OrderItem[];
    ordersLoading: boolean;
    settings: SettingsState;
    schedulerConfig: SchedulerConfig;
    schedulerCurlCommand: string;
    schedulerCrontabCommand: string;
    retryingCallbackId: string | null;
    retryingBulkCallbacks: boolean;
    processingDueRetries: boolean;
    handleRetryCallback: (orderId: string) => Promise<void>;
    handleRetryPendingCallbacks: () => Promise<void>;
    handleProcessDueRetries: () => Promise<void>;
    copyToClipboard: (value: string, successText: string) => Promise<void>;
}) => (
    <div className="grid gap-5 xl:grid-cols-[1.1fr_1fr]">
        <div className="space-y-5">
            <div className="rounded-2xl border ui-border ui-panel-muted p-5">
                <div>
                    <h2 className="text-lg font-bold ui-text">Webhook / Callback</h2>
                    <p className="text-sm ui-text-muted">Monitor log inbound request seller dan callback outbound ke Digiflazz.</p>
                </div>

                <div className="mt-4 overflow-x-auto">
                    <table className="min-w-full text-sm">
                        <thead>
                            <tr className="border-b ui-border text-left ui-text-muted">
                                <th className="px-4 py-3 font-medium">Waktu</th>
                                <th className="px-4 py-3 font-medium">Event</th>
                                <th className="px-4 py-3 font-medium">Ref ID</th>
                                <th className="px-4 py-3 font-medium">Status</th>
                                <th className="px-4 py-3 font-medium">Pesan</th>
                            </tr>
                        </thead>
                        <tbody>
                            {logsLoading ? (
                                <tr>
                                    <td colSpan={5} className="px-4 py-8 text-center ui-text-muted">Memuat log...</td>
                                </tr>
                            ) : logs.length === 0 ? (
                                <tr>
                                    <td colSpan={5} className="px-4 py-8 text-center ui-text-muted">Belum ada log callback Digiflazz Seller.</td>
                                </tr>
                            ) : logs.map((log) => (
                                <tr key={log.id} className="border-b ui-border align-top ui-text hover:bg-[var(--ui-card-bg)]">
                                    <td className="px-4 py-4 text-xs">{new Date(log.timestamp).toLocaleString('id-ID')}</td>
                                    <td className="px-4 py-4 text-xs uppercase ui-warning-text">{log.event}</td>
                                    <td className="px-4 py-4 font-mono text-xs">{log.refId}</td>
                                    <td className="px-4 py-4">
                                        <span className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold ${log.delivered ? 'ui-success-chip' : 'ui-warning-chip'}`}>
                                            {log.status}
                                        </span>
                                    </td>
                                    <td className="px-4 py-4 text-xs ui-text-muted">{log.message}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>

        <div className="space-y-5">
            <div className="rounded-2xl border ui-border ui-panel-muted p-5">
                <div className="flex items-center justify-between">
                    <div>
                        <h2 className="text-lg font-bold ui-text">Recent Orders</h2>
                        <p className="text-sm ui-text-muted">Lihat order seller yang baru masuk dan status callback-nya.</p>
                    </div>
                    <div className="flex flex-wrap justify-end gap-2">
                        <button
                            onClick={handleProcessDueRetries}
                            disabled={processingDueRetries || settings.orderSummary.callbackDueRetry <= 0}
                            className="inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold ui-info-action disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            {processingDueRetries ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                            Process Due ({settings.orderSummary.callbackDueRetry})
                        </button>
                        <button
                            onClick={handleRetryPendingCallbacks}
                            disabled={retryingBulkCallbacks || settings.orderSummary.callbackPending <= 0}
                            className="inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold ui-warning-action disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            {retryingBulkCallbacks ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                            Retry Pending ({settings.orderSummary.callbackPending})
                        </button>
                    </div>
                </div>

                <div className="mt-4 space-y-3">
                    <div className="rounded-xl border ui-border ui-panel p-4">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                            <div>
                                <p className="text-xs uppercase tracking-[0.18em] ui-text-muted">Retry Queue Health</p>
                                <p className="mt-1 text-sm font-bold ui-text">
                                    {settings.retryQueueHealth.status === 'never'
                                        ? 'Scheduler belum pernah jalan'
                                        : `Run terakhir ${formatDateTime(settings.retryQueueHealth.lastRunAt)}`}
                                </p>
                                <p className="mt-1 text-xs ui-text-muted">
                                    Source {settings.retryQueueHealth.source} • Processed {settings.retryQueueHealth.processed} • Success {settings.retryQueueHealth.successCount} • Failed {settings.retryQueueHealth.failedCount}
                                </p>
                                {settings.retryQueueHealth.lastError && (
                                    <p className="mt-2 text-xs font-semibold ui-danger-text">{settings.retryQueueHealth.lastError}</p>
                                )}
                            </div>
                            <div className="flex flex-wrap justify-end gap-2">
                                <span className={`rounded-full border px-3 py-1 text-xs font-black ${settings.retryQueueHealth.status === 'failed' ? 'ui-danger-chip' : settings.retryQueueHealth.status === 'partial' ? 'ui-warning-chip' : settings.retryQueueHealth.status === 'success' ? 'ui-success-chip' : 'ui-panel-muted ui-text-muted'}`}>
                                    {settings.retryQueueHealth.status.toUpperCase()}
                                </span>
                                {settings.orderSummary.callbackHighAttempt > 0 && (
                                    <span className="rounded-full border px-3 py-1 text-xs font-black ui-danger-chip">
                                        {settings.orderSummary.callbackHighAttempt} high attempt
                                    </span>
                                )}
                            </div>
                        </div>
                    </div>

                    <div className="rounded-xl border ui-border ui-panel p-4">
                        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                            <div className="min-w-0 space-y-2">
                                <p className="text-xs uppercase tracking-[0.18em] ui-text-muted">Scheduler Setup</p>
                                <p className="text-sm font-bold ui-text">Auto process retry queue setiap {schedulerConfig.recommendedIntervalMinutes} menit</p>
                                <p className="text-xs leading-6 ui-text-muted">
                                    Pasang command ini di cron/server scheduler eksternal. Token tidak ditampilkan di UI; gunakan environment variable <span className="font-mono ui-text">DIGIFLAZZ_SELLER_RETRY_QUEUE_TOKEN</span> di mesin scheduler.
                                </p>
                                <div className="flex flex-wrap gap-2">
                                    <span className={`rounded-full border px-3 py-1 text-xs font-black ${schedulerConfig.tokenConfigured ? 'ui-success-chip' : 'ui-danger-chip'}`}>
                                        Token {schedulerConfig.tokenConfigured ? 'configured' : 'not configured'}
                                    </span>
                                    <span className="rounded-full border px-3 py-1 text-xs font-black ui-info-chip">
                                        Limit max {schedulerConfig.maxLimit}
                                    </span>
                                </div>
                            </div>
                        </div>

                        <div className="mt-4 grid gap-3 xl:grid-cols-2">
                            <div className="rounded-xl border ui-border ui-panel-muted p-3">
                                <div className="flex items-center justify-between gap-2">
                                    <p className="text-xs font-black uppercase tracking-[0.16em] ui-text-muted">Curl Test</p>
                                    <button
                                        onClick={() => copyToClipboard(schedulerCurlCommand, 'Command curl scheduler berhasil disalin')}
                                        className="inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-bold ui-muted-action"
                                    >
                                        <Copy className="h-3 w-3" /> Copy
                                    </button>
                                </div>
                                <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-all rounded-lg ui-panel px-3 py-2 text-[11px] leading-5 ui-text-muted">{schedulerCurlCommand}</pre>
                            </div>
                            <div className="rounded-xl border ui-border ui-panel-muted p-3">
                                <div className="flex items-center justify-between gap-2">
                                    <p className="text-xs font-black uppercase tracking-[0.16em] ui-text-muted">Crontab</p>
                                    <button
                                        onClick={() => copyToClipboard(schedulerCrontabCommand, 'Crontab scheduler berhasil disalin')}
                                        className="inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-bold ui-muted-action"
                                    >
                                        <Copy className="h-3 w-3" /> Copy
                                    </button>
                                </div>
                                <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-all rounded-lg ui-panel px-3 py-2 text-[11px] leading-5 ui-text-muted">{schedulerCrontabCommand}</pre>
                            </div>
                        </div>
                    </div>

                    {ordersLoading ? (
                        <div className="rounded-xl border ui-border ui-panel px-4 py-8 text-center text-sm ui-text-muted">Memuat order...</div>
                    ) : orders.length === 0 ? (
                        <div className="rounded-xl border ui-border ui-panel px-4 py-8 text-center text-sm ui-text-muted">Belum ada order Digiflazz Seller.</div>
                    ) : orders.map((order) => (
                        <div key={order.id} className="rounded-xl border ui-border ui-panel p-4">
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                <div>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="font-mono text-sm ui-warning-text">{order.refId}</span>
                                        <span className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold ${order.status === 'success' ? 'ui-success-chip' : order.status === 'failed' ? 'ui-danger-chip' : 'ui-warning-chip'}`}>
                                            {order.status.toUpperCase()}
                                        </span>
                                        <span className="rounded-full ui-panel-muted px-2.5 py-1 text-[11px] font-semibold ui-text-muted">RC {order.rc}</span>
                                    </div>
                                    <div className="mt-2 text-sm ui-text">{order.product?.name || order.pulsaCode}</div>
                                    <div className="mt-1 text-xs ui-text-muted">
                                        Target {order.target} • Harga Rp{currencyFormatter.format(order.price)} • Vendor {order.product?.vendorName || '-'}
                                    </div>
                                    <div className="mt-2 text-xs ui-text-muted">{order.message}</div>
                                </div>
                                <div className="space-y-2 text-right text-xs ui-text-muted">
                                    <div>Masuk {formatDateTime(order.createdAt)}</div>
                                    <div>Callback percobaan {order.callbackAttemptCount}</div>
                                    {order.callbackLastAttemptAt && <div>Attempt terakhir {formatDateTime(order.callbackLastAttemptAt)}</div>}
                                    {order.callbackRequired && <div>Retry berikutnya {formatDateTime(order.callbackNextRetryAt)}</div>}
                                    {order.callbackLastMessage && <div>{order.callbackLastMessage}</div>}
                                </div>
                            </div>

                            {order.callbackRequired && (
                                <div className="mt-4 flex justify-end">
                                    <button
                                        onClick={() => handleRetryCallback(order.id)}
                                        disabled={retryingCallbackId === order.id}
                                        className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold ui-warning-action disabled:cursor-not-allowed disabled:opacity-60"
                                    >
                                        {retryingCallbackId === order.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                                        Retry Callback
                                    </button>
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            </div>
        </div>
    </div>
);
