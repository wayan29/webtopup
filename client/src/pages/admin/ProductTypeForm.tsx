import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { apiV2 } from '../../api';
import {
    ArrowLeft,
    Save,
    Image as ImageIcon,
    Info,
    Loader2,
    Clock,
    Tag,
    Settings,
    FileText,
    FolderOpen,
    Upload,
    X,
    ChevronDown,
} from 'lucide-react';
import ImagePicker from '../../components/admin/ImagePicker';

interface Category {
    _id: string;
    name: string;
    slug: string;
    icon: string;
}

interface Operator {
    _id: string;
    name: string;
    slug: string;
    icon?: string;
    categoryId: string | { _id: string };
}

type SectionId = 'identity' | 'operations' | 'extra';

function FormSection({
    id,
    title,
    icon: Icon,
    open,
    onToggle,
    children,
}: {
    id: SectionId;
    title: string;
    icon: typeof Tag;
    open: boolean;
    onToggle: (id: SectionId) => void;
    children: ReactNode;
}) {
    return (
        <section className="ui-panel border ui-border rounded-xl overflow-hidden">
            <button
                type="button"
                onClick={() => onToggle(id)}
                className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left hover:bg-[var(--ui-card-muted)]/40 transition-colors"
                aria-expanded={open}
            >
                <span className="flex items-center gap-2 text-base font-semibold ui-text">
                    <Icon className="w-4 h-4 ui-accent-text" />
                    {title}
                </span>
                <ChevronDown className={`h-4 w-4 ui-text-muted transition-transform ${open ? 'rotate-180' : ''}`} />
            </button>
            {open ? <div className="border-t ui-border px-5 pb-5 pt-4">{children}</div> : null}
        </section>
    );
}

export default function ProductTypeForm() {
    const navigate = useNavigate();
    const { id } = useParams();
    const [searchParams] = useSearchParams();
    const isEdit = Boolean(id);

    const urlCategoryId = searchParams.get('category') || '';
    const urlOperatorId = searchParams.get('operator') || '';

    const [categories, setCategories] = useState<Category[]>([]);
    const [operators, setOperators] = useState<Operator[]>([]);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
    const [openSections, setOpenSections] = useState<Record<SectionId, boolean>>({
        identity: true,
        operations: true,
        extra: true,
    });

    const [formData, setFormData] = useState({
        name: '',
        categoryId: urlCategoryId,
        operatorId: urlOperatorId,
        icon: '',
        cover: '',
        openTime: '00:00',
        closeTime: '23:59',
        open24Hours: true,
        estimatedDelivery: '',
        status: true,
        processType: 'auto' as 'auto' | 'manual',
        description: '',
        popupInfo: {
            title: '',
            content: '',
            image: '',
            buttonText: '',
            buttonLink: '',
            enabled: false,
        },
    });

    const [uploading, setUploading] = useState<string | null>(null);
    const [showIconPicker, setShowIconPicker] = useState(false);
    const [showCoverPicker, setShowCoverPicker] = useState(false);
    const latestRequestId = useRef(0);
    const navigateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const listPath = () => {
        const params = new URLSearchParams();
        if (formData.categoryId) params.set('category', formData.categoryId);
        if (formData.operatorId) params.set('operator', formData.operatorId);
        const search = searchParams.get('search');
        const status = searchParams.get('status');
        if (search) params.set('search', search);
        if (status) params.set('status', status);
        const query = params.toString();
        return `/admin/product-types${query ? `?${query}` : ''}`;
    };

    const toggleSection = (sectionId: SectionId) => {
        setOpenSections((current) => ({ ...current, [sectionId]: !current[sectionId] }));
    };

    useEffect(() => {
        // Prefill create form from list tab query (?category=&operator=).
        if (isEdit) return;
        setFormData((current) => ({
            ...current,
            categoryId: current.categoryId || urlCategoryId,
            operatorId: current.operatorId || urlOperatorId,
        }));
    }, [isEdit, urlCategoryId, urlOperatorId]);

    useEffect(() => {
        fetchData();
        return () => {
            if (navigateTimeoutRef.current) {
                clearTimeout(navigateTimeoutRef.current);
            }
        };
    }, [id]);

    const fetchData = async () => {
        const requestId = latestRequestId.current + 1;
        latestRequestId.current = requestId;

        try {
            setLoading(true);
            const [categoriesRes, operatorsRes] = await Promise.all([
                apiV2.get('/categories/admin/all'),
                apiV2.get('/operators/admin/all'),
            ]);
            if (requestId !== latestRequestId.current) return;
            setCategories(categoriesRes.data);
            setOperators(operatorsRes.data);

            if (isEdit) {
                const res = await apiV2.get(`/product-types/admin/${id}`);
                if (requestId !== latestRequestId.current) return;
                const pt = res.data;
                setFormData({
                    name: pt.name || '',
                    categoryId: typeof pt.categoryId === 'object' ? pt.categoryId._id : pt.categoryId || '',
                    operatorId: typeof pt.operatorId === 'object' ? pt.operatorId._id : pt.operatorId || '',
                    icon: pt.icon || '',
                    cover: pt.cover || '',
                    openTime: pt.openTime || '00:00',
                    closeTime: pt.closeTime || '23:59',
                    open24Hours: pt.open24Hours ?? true,
                    estimatedDelivery: pt.estimatedDelivery || '',
                    status: pt.status ?? true,
                    processType: pt.processType || 'auto',
                    description: pt.description || '',
                    popupInfo: {
                        title: pt.popupInfo?.title || '',
                        content: pt.popupInfo?.content || '',
                        image: pt.popupInfo?.image || '',
                        buttonText: pt.popupInfo?.buttonText || '',
                        buttonLink: pt.popupInfo?.buttonLink || '',
                        enabled: pt.popupInfo?.enabled || false,
                    },
                });
            }
        } catch (error) {
            if (requestId !== latestRequestId.current) return;
            console.error('Failed to fetch data', error);
            setMessage({ type: 'error', text: 'Gagal memuat data' });
        } finally {
            if (requestId === latestRequestId.current) {
                setLoading(false);
            }
        }
    };

    const getCategoryId = (op?: Operator | null): string => {
        if (!op) return '';
        const category = (op as any).categoryId;
        if (category && typeof category === 'object') {
            return category._id || '';
        }
        return category || '';
    };

    const filteredOperators = useMemo(() => {
        if (!formData.categoryId) return operators;
        return operators.filter((op) => op && getCategoryId(op) === formData.categoryId);
    }, [operators, formData.categoryId]);

    const handleFileUpload = (field: 'icon' | 'cover' | 'popupImage') => async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        const uploadType = field === 'icon' ? 'icons' : field === 'cover' ? 'covers' : 'popups';
        setUploading(field);

        try {
            const formDataUpload = new FormData();
            formDataUpload.append('file', file);

            const res = await apiV2.post(`/upload?type=${uploadType}`, formDataUpload, {
                headers: { 'Content-Type': 'multipart/form-data' },
            });

            if (res.data.success) {
                if (field === 'popupImage') {
                    setFormData((prev) => ({
                        ...prev,
                        popupInfo: { ...prev.popupInfo, image: res.data.url },
                    }));
                } else {
                    setFormData((prev) => ({ ...prev, [field]: res.data.url }));
                }
            }
        } catch (error) {
            console.error('Upload failed:', error);
            setMessage({ type: 'error', text: 'Gagal upload file' });
        } finally {
            setUploading(null);
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setSaving(true);
        setMessage(null);
        if (!formData.name.trim() || !formData.categoryId || !formData.operatorId) {
            setMessage({ type: 'error', text: 'Nama, kategori, dan operator wajib diisi' });
            setSaving(false);
            setOpenSections((current) => ({ ...current, identity: true }));
            return;
        }

        const payload = {
            ...formData,
            openTime: formData.open24Hours ? '00:00' : formData.openTime,
            closeTime: formData.open24Hours ? '23:59' : formData.closeTime,
        };

        try {
            if (isEdit) {
                await apiV2.put(`/product-types/admin/${id}`, payload);
                setMessage({ type: 'success', text: 'Jenis produk berhasil diperbarui' });
            } else {
                await apiV2.post('/product-types/admin/create', payload);
                setMessage({ type: 'success', text: 'Jenis produk berhasil ditambahkan' });
            }
            if (navigateTimeoutRef.current) {
                clearTimeout(navigateTimeoutRef.current);
            }
            navigateTimeoutRef.current = setTimeout(() => navigate(listPath()), 900);
        } catch (error: any) {
            setMessage({ type: 'error', text: error.response?.data?.message || 'Gagal menyimpan jenis produk' });
        } finally {
            setSaving(false);
        }
    };

    const canSave =
        Boolean(formData.name.trim() && formData.categoryId && formData.operatorId) && !saving;
    const selectedCategoryName = categories.find((cat) => cat._id === formData.categoryId)?.name;
    const selectedOperatorName = filteredOperators.find((op) => op._id === formData.operatorId)?.name
        || operators.find((op) => op._id === formData.operatorId)?.name;

    if (loading) {
        return (
            <div className="flex min-h-[50vh] items-center justify-center">
                <div className="flex flex-col items-center gap-2">
                    <Loader2 className="w-8 h-8 ui-accent-text animate-spin" />
                    <p className="ui-text-muted text-sm">Memuat data jenis produk...</p>
                </div>
            </div>
        );
    }

    return (
        <div className="mx-auto w-full max-w-6xl space-y-4 pb-28">
            <div className="sticky top-0 z-20 -mx-1 border-b ui-border bg-[color-mix(in_srgb,var(--ui-panel)_92%,transparent)] px-1 py-3 backdrop-blur supports-[backdrop-filter]:bg-[color-mix(in_srgb,var(--ui-panel)_78%,transparent)]">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                        <button
                            type="button"
                            onClick={() => navigate(listPath())}
                            disabled={saving}
                            className="mb-1 inline-flex items-center gap-2 text-sm ui-text-muted hover:text-[var(--ui-text)] transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            <ArrowLeft className="w-4 h-4" />
                            Kembali ke Daftar Jenis Produk
                        </button>
                        <h1 className="truncate text-xl font-black ui-text sm:text-2xl">
                            {isEdit ? 'Edit Jenis Produk' : 'Tambah Jenis Produk'}
                        </h1>
                        <p className="mt-0.5 text-xs ui-text-muted">
                            {[selectedCategoryName && `Kategori: ${selectedCategoryName}`, selectedOperatorName && `Operator: ${selectedOperatorName}`]
                                .filter(Boolean)
                                .join(' · ') || 'Lengkapi identitas, lalu konfigurasi operasional.'}
                            {!isEdit && (urlCategoryId || urlOperatorId)
                                ? ' · Filter dari list ikut terbawa.'
                                : ''}
                        </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        {message && (
                            <div
                                className={`rounded-lg border px-3 py-2 text-xs font-semibold sm:text-sm ${
                                    message.type === 'success' ? 'ui-success-chip' : 'ui-danger-chip'
                                }`}
                            >
                                {message.text}
                            </div>
                        )}
                        <button
                            type="button"
                            onClick={() => navigate(listPath())}
                            disabled={saving}
                            className="ui-muted-action rounded-xl border px-4 py-2.5 text-sm font-semibold disabled:opacity-50"
                        >
                            Batal
                        </button>
                        <button
                            type="submit"
                            form="product-type-form"
                            disabled={!canSave}
                            className="ui-accent-solid inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                            {saving ? 'Menyimpan…' : 'Simpan'}
                        </button>
                    </div>
                </div>
            </div>

            <form id="product-type-form" onSubmit={handleSubmit} className="space-y-4">
                <FormSection
                    id="identity"
                    title="1. Identitas Produk"
                    icon={Tag}
                    open={openSections.identity}
                    onToggle={toggleSection}
                >
                    <div className="space-y-5">
                        <div>
                            <label className="block text-xs font-medium ui-text-muted mb-1.5 uppercase tracking-wide">
                                Nama Jenis Produk
                            </label>
                            <input
                                type="text"
                                required
                                value={formData.name}
                                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                                className="block w-full border ui-border rounded-lg py-2.5 px-4 ui-panel-muted ui-text focus:ring-1 focus:ring-[var(--ui-accent)] focus:border-[var(--ui-accent)] text-sm placeholder-[var(--ui-text-muted)] transition-all"
                                placeholder="Contoh: Free Fire MAX"
                            />
                        </div>

                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                            <div>
                                <label className="block text-xs font-medium ui-text-muted mb-1.5 uppercase tracking-wide">
                                    Kategori
                                </label>
                                <select
                                    required
                                    value={formData.categoryId}
                                    onChange={(e) =>
                                        setFormData({ ...formData, categoryId: e.target.value, operatorId: '' })
                                    }
                                    className="block w-full border ui-border rounded-lg py-2.5 px-4 ui-panel-muted ui-text focus:ring-1 focus:ring-[var(--ui-accent)] focus:border-[var(--ui-accent)] text-sm transition-all"
                                >
                                    <option value="">Pilih Kategori...</option>
                                    {categories.map((cat) => (
                                        <option key={cat._id} value={cat._id}>
                                            {cat.name}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label className="block text-xs font-medium ui-text-muted mb-1.5 uppercase tracking-wide">
                                    Operator
                                </label>
                                <select
                                    required
                                    value={formData.operatorId}
                                    onChange={(e) => setFormData({ ...formData, operatorId: e.target.value })}
                                    className="block w-full border ui-border rounded-lg py-2.5 px-4 ui-panel-muted ui-text focus:ring-1 focus:ring-[var(--ui-accent)] focus:border-[var(--ui-accent)] text-sm transition-all"
                                    disabled={!formData.categoryId}
                                >
                                    <option value="">Pilih Operator...</option>
                                    {filteredOperators.map((op) => (
                                        <option key={op._id} value={op._id}>
                                            {op.name}
                                        </option>
                                    ))}
                                </select>
                                {!formData.categoryId && (
                                    <p className="mt-1.5 text-xs ui-warning-text">Pilih kategori dulu agar operator terfilter.</p>
                                )}
                            </div>
                        </div>

                        <div>
                            <label className="block text-xs font-medium ui-text-muted mb-2 uppercase tracking-wide">
                                Icon Produk
                            </label>
                            <div className="flex gap-4">
                                <div className="flex-shrink-0">
                                    <div className="w-24 h-24 rounded-lg border-2 border-dashed ui-border ui-panel-muted flex items-center justify-center overflow-hidden relative group/icon">
                                        {formData.icon ? (
                                            <>
                                                <img src={formData.icon} alt="icon" className="w-full h-full object-cover" />
                                                <div className="absolute inset-0 bg-black/50 flex items-center justify-center opacity-0 group-hover/icon:opacity-100 transition-opacity">
                                                    <button
                                                        type="button"
                                                        onClick={() => setFormData({ ...formData, icon: '' })}
                                                        className="ui-danger-action rounded-full p-1.5"
                                                    >
                                                        <X className="w-4 h-4" />
                                                    </button>
                                                </div>
                                            </>
                                        ) : (
                                            <ImageIcon className="w-8 h-8 ui-text-muted" />
                                        )}
                                    </div>
                                </div>
                                <div className="flex-1 space-y-3">
                                    <button
                                        type="button"
                                        onClick={() => setShowIconPicker(true)}
                                        className="flex items-center justify-center gap-2 w-full px-4 py-2.5 ui-accent-chip border border-[color-mix(in_srgb,var(--ui-accent)_34%,transparent)] rounded-lg text-sm ui-accent-text hover:text-[var(--ui-accent-strong)] transition-all"
                                    >
                                        <FolderOpen className="w-4 h-4" />
                                        Pilih dari Galeri
                                    </button>
                                    <label
                                        className={`block w-full text-center px-4 py-2.5 ui-panel-muted border ui-border rounded-lg text-sm ui-text-muted hover:bg-[var(--ui-panel-muted)] hover:text-[var(--ui-text)] cursor-pointer transition-colors ${
                                            uploading === 'icon' ? 'opacity-50 cursor-wait' : ''
                                        }`}
                                    >
                                        {uploading === 'icon' ? (
                                            <div className="flex items-center justify-center gap-2">
                                                <Loader2 className="w-4 h-4 animate-spin" /> Uploading...
                                            </div>
                                        ) : (
                                            <div className="flex items-center justify-center gap-2">
                                                <Upload className="w-4 h-4" /> Upload File Baru
                                            </div>
                                        )}
                                        <input
                                            type="file"
                                            accept="image/*"
                                            className="hidden"
                                            onChange={handleFileUpload('icon')}
                                            disabled={uploading === 'icon'}
                                        />
                                    </label>
                                </div>
                            </div>
                        </div>

                        <div>
                            <label className="block text-xs font-medium ui-text-muted mb-2 uppercase tracking-wide">
                                Cover Image (Opsional)
                            </label>
                            <div className="flex gap-4">
                                <div className="flex-shrink-0">
                                    <div className="w-32 h-20 rounded-lg border-2 border-dashed ui-border ui-panel-muted flex items-center justify-center overflow-hidden relative group/cover">
                                        {formData.cover ? (
                                            <>
                                                <img src={formData.cover} alt="cover" className="w-full h-full object-cover" />
                                                <div className="absolute inset-0 bg-black/50 flex items-center justify-center opacity-0 group-hover/cover:opacity-100 transition-opacity">
                                                    <button
                                                        type="button"
                                                        onClick={() => setFormData({ ...formData, cover: '' })}
                                                        className="ui-danger-action rounded-full p-1.5"
                                                    >
                                                        <X className="w-4 h-4" />
                                                    </button>
                                                </div>
                                            </>
                                        ) : (
                                            <ImageIcon className="w-8 h-8 ui-text-muted" />
                                        )}
                                    </div>
                                </div>
                                <div className="flex-1 space-y-3">
                                    <button
                                        type="button"
                                        onClick={() => setShowCoverPicker(true)}
                                        className="flex items-center justify-center gap-2 w-full px-4 py-2.5 ui-accent-chip border border-[color-mix(in_srgb,var(--ui-accent)_34%,transparent)] rounded-lg text-sm ui-accent-text hover:text-[var(--ui-accent-strong)] transition-all"
                                    >
                                        <FolderOpen className="w-4 h-4" />
                                        Pilih dari Galeri
                                    </button>
                                    <label
                                        className={`block w-full text-center px-4 py-2.5 ui-panel-muted border ui-border rounded-lg text-sm ui-text-muted hover:bg-[var(--ui-panel-muted)] hover:text-[var(--ui-text)] cursor-pointer transition-colors ${
                                            uploading === 'cover' ? 'opacity-50 cursor-wait' : ''
                                        }`}
                                    >
                                        {uploading === 'cover' ? (
                                            <div className="flex items-center justify-center gap-2">
                                                <Loader2 className="w-4 h-4 animate-spin" /> Uploading...
                                            </div>
                                        ) : (
                                            <div className="flex items-center justify-center gap-2">
                                                <Upload className="w-4 h-4" /> Upload File Baru
                                            </div>
                                        )}
                                        <input
                                            type="file"
                                            accept="image/*"
                                            className="hidden"
                                            onChange={handleFileUpload('cover')}
                                            disabled={uploading === 'cover'}
                                        />
                                    </label>
                                </div>
                            </div>
                        </div>
                    </div>
                </FormSection>

                <FormSection
                    id="operations"
                    title="2. Konfigurasi Operasional"
                    icon={Settings}
                    open={openSections.operations}
                    onToggle={toggleSection}
                >
                    <div className="space-y-5">
                        <div>
                            <div className="flex items-center justify-between mb-2">
                                <label className="block text-xs font-medium ui-text-muted uppercase tracking-wide">
                                    Jam Operasional
                                </label>
                                <div className="flex items-center gap-2">
                                    <input
                                        type="checkbox"
                                        id="open24Hours"
                                        checked={formData.open24Hours}
                                        onChange={(e) => setFormData({ ...formData, open24Hours: e.target.checked })}
                                        className="w-3.5 h-3.5 ui-accent-text ui-panel-muted ui-border rounded"
                                    />
                                    <label htmlFor="open24Hours" className="text-xs ui-accent-text font-medium cursor-pointer select-none">
                                        Buka 24 Jam
                                    </label>
                                </div>
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                                <div className="relative">
                                    <div className="absolute inset-y-0 left-3 flex items-center pointer-events-none">
                                        <Clock className="w-4 h-4 ui-text-muted" />
                                    </div>
                                    <input
                                        type="time"
                                        value={formData.openTime}
                                        onChange={(e) => setFormData({ ...formData, openTime: e.target.value })}
                                        className={`block w-full border ui-border rounded-lg py-2 pl-9 pr-3 ui-panel-muted ui-text text-sm focus:ring-1 focus:ring-[var(--ui-accent)] focus:border-[var(--ui-accent)] ${
                                            formData.open24Hours ? 'opacity-50 cursor-not-allowed' : ''
                                        }`}
                                        disabled={formData.open24Hours}
                                    />
                                </div>
                                <div className="relative">
                                    <div className="absolute inset-y-0 left-3 flex items-center pointer-events-none">
                                        <Clock className="w-4 h-4 ui-text-muted" />
                                    </div>
                                    <input
                                        type="time"
                                        value={formData.closeTime}
                                        onChange={(e) => setFormData({ ...formData, closeTime: e.target.value })}
                                        className={`block w-full border ui-border rounded-lg py-2 pl-9 pr-3 ui-panel-muted ui-text text-sm focus:ring-1 focus:ring-[var(--ui-accent)] focus:border-[var(--ui-accent)] ${
                                            formData.open24Hours ? 'opacity-50 cursor-not-allowed' : ''
                                        }`}
                                        disabled={formData.open24Hours}
                                    />
                                </div>
                            </div>
                        </div>

                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                            <div>
                                <label className="block text-xs font-medium ui-text-muted mb-1.5 uppercase tracking-wide">
                                    Status Produk
                                </label>
                                <select
                                    value={formData.status ? 'active' : 'inactive'}
                                    onChange={(e) => setFormData({ ...formData, status: e.target.value === 'active' })}
                                    className={`block w-full border ui-border rounded-lg py-2 px-3 ui-panel-muted text-sm font-medium ${
                                        formData.status ? 'ui-success-text' : 'ui-text-muted'
                                    }`}
                                >
                                    <option value="active">Aktif</option>
                                    <option value="inactive">Nonaktif</option>
                                </select>
                            </div>
                            <div>
                                <label className="block text-xs font-medium ui-text-muted mb-1.5 uppercase tracking-wide">
                                    Tipe Proses
                                </label>
                                <select
                                    value={formData.processType}
                                    onChange={(e) =>
                                        setFormData({ ...formData, processType: e.target.value as 'auto' | 'manual' })
                                    }
                                    className="block w-full border ui-border rounded-lg py-2 px-3 ui-panel-muted ui-text text-sm"
                                >
                                    <option value="auto">Otomatis</option>
                                    <option value="manual">Manual</option>
                                </select>
                            </div>
                        </div>

                        <div>
                            <label className="block text-xs font-medium ui-text-muted mb-1.5 uppercase tracking-wide">
                                Estimasi Pengiriman
                            </label>
                            <input
                                type="text"
                                value={formData.estimatedDelivery}
                                onChange={(e) => setFormData({ ...formData, estimatedDelivery: e.target.value })}
                                className="block w-full border ui-border rounded-lg py-2 px-4 ui-panel-muted ui-text text-sm placeholder-[var(--ui-text-muted)]"
                                placeholder="Contoh: 1-5 Menit"
                            />
                        </div>
                    </div>
                </FormSection>

                <FormSection
                    id="extra"
                    title="3. Informasi Tambahan"
                    icon={FileText}
                    open={openSections.extra}
                    onToggle={toggleSection}
                >
                    <div className="space-y-4">
                        <div>
                            <div className="flex justify-between items-center mb-1.5">
                                <label className="block text-xs font-medium ui-text-muted uppercase tracking-wide">
                                    Deskripsi Form Akun
                                </label>
                                <div className="text-[10px] ui-text-muted">Supports HTML</div>
                            </div>
                            <textarea
                                value={formData.description}
                                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                                rows={4}
                                className="block w-full border ui-border rounded-lg py-2 px-3 ui-panel-muted ui-text text-sm placeholder-[var(--ui-text-muted)] resize-y"
                                placeholder="Deskripsi yang muncul di atas form input user ID..."
                            />
                        </div>

                        <div className="border-t ui-border pt-4 mt-2">
                            <div className="flex items-center justify-between mb-3">
                                <label className="text-xs font-bold ui-text flex items-center gap-2">
                                    <Info className="w-3.5 h-3.5 ui-info-text" />
                                    Informasi Popup
                                </label>
                                <div className="relative inline-flex items-center cursor-pointer">
                                    <input
                                        type="checkbox"
                                        className="sr-only peer"
                                        checked={formData.popupInfo.enabled}
                                        onChange={(e) =>
                                            setFormData({
                                                ...formData,
                                                popupInfo: { ...formData.popupInfo, enabled: e.target.checked },
                                            })
                                        }
                                    />
                                    <div className="w-9 h-5 ui-panel-muted peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-[var(--ui-card-bg)] after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-[var(--ui-card-bg)] after:ui-border after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[var(--ui-accent)]"></div>
                                </div>
                            </div>

                            {formData.popupInfo.enabled && (
                                <div className="space-y-3 p-3 ui-panel-muted rounded-lg border ui-border">
                                    <input
                                        type="text"
                                        value={formData.popupInfo.title}
                                        onChange={(e) =>
                                            setFormData({
                                                ...formData,
                                                popupInfo: { ...formData.popupInfo, title: e.target.value },
                                            })
                                        }
                                        className="block w-full border ui-border rounded px-3 py-2 ui-panel ui-text text-xs"
                                        placeholder="Judul Popup"
                                    />
                                    <textarea
                                        value={formData.popupInfo.content}
                                        onChange={(e) =>
                                            setFormData({
                                                ...formData,
                                                popupInfo: { ...formData.popupInfo, content: e.target.value },
                                            })
                                        }
                                        rows={2}
                                        className="block w-full border ui-border rounded px-3 py-2 ui-panel ui-text text-xs resize-none"
                                        placeholder="Isi pesan popup..."
                                    />
                                    <div className="grid gap-2 sm:grid-cols-2">
                                        <input
                                            type="text"
                                            value={formData.popupInfo.buttonText}
                                            onChange={(e) =>
                                                setFormData({
                                                    ...formData,
                                                    popupInfo: { ...formData.popupInfo, buttonText: e.target.value },
                                                })
                                            }
                                            className="border ui-border rounded px-3 py-2 ui-panel ui-text text-xs"
                                            placeholder="Label Tombol"
                                        />
                                        <input
                                            type="text"
                                            value={formData.popupInfo.buttonLink}
                                            onChange={(e) =>
                                                setFormData({
                                                    ...formData,
                                                    popupInfo: { ...formData.popupInfo, buttonLink: e.target.value },
                                                })
                                            }
                                            className="border ui-border rounded px-3 py-2 ui-panel ui-text text-xs"
                                            placeholder="Link Tombol Popup"
                                        />
                                        <input
                                            type="text"
                                            value={formData.popupInfo.image}
                                            onChange={(e) =>
                                                setFormData({
                                                    ...formData,
                                                    popupInfo: { ...formData.popupInfo, image: e.target.value },
                                                })
                                            }
                                            className="border ui-border rounded px-3 py-2 ui-panel ui-text text-xs sm:col-span-2"
                                            placeholder="URL Gambar Popup"
                                        />
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </FormSection>
            </form>

            <div className="fixed inset-x-0 bottom-0 z-20 border-t ui-border bg-[color-mix(in_srgb,var(--ui-panel)_94%,transparent)] px-4 py-3 backdrop-blur sm:px-6">
                <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-xs ui-text-muted">
                        {canSave
                            ? isEdit
                                ? 'Perubahan siap disimpan.'
                                : 'Siap menambah jenis produk ke operator terpilih.'
                            : 'Lengkapi nama, kategori, dan operator di bagian Identitas.'}
                    </p>
                    <div className="flex gap-2">
                        <button
                            type="button"
                            onClick={() => navigate(listPath())}
                            disabled={saving}
                            className="ui-muted-action flex-1 rounded-xl border px-4 py-2.5 text-sm font-semibold sm:flex-none disabled:opacity-50"
                        >
                            Batal
                        </button>
                        <button
                            type="submit"
                            form="product-type-form"
                            disabled={!canSave}
                            className="ui-accent-solid inline-flex flex-1 items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-50 sm:flex-none"
                        >
                            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                            {saving ? 'Menyimpan…' : 'Simpan Data'}
                        </button>
                    </div>
                </div>
            </div>

            <ImagePicker
                isOpen={showIconPicker}
                onClose={() => setShowIconPicker(false)}
                onSelect={(url) => setFormData({ ...formData, icon: url })}
                currentValue={formData.icon}
                type="icons"
                title="Pilih Icon Produk"
            />
            <ImagePicker
                isOpen={showCoverPicker}
                onClose={() => setShowCoverPicker(false)}
                onSelect={(url) => setFormData({ ...formData, cover: url })}
                currentValue={formData.cover}
                type="covers"
                title="Pilih Cover Image"
            />
        </div>
    );
}
