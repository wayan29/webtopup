import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { apiV2 } from '../../api';
import {
    ArrowLeft,
    Save,
    X,
    Upload,
    Image as ImageIcon,
    Loader2,
    Settings,
    FileText,
    CheckCircle,
    Tag,
    Database,
    Shield,
    FolderOpen,
    ChevronDown,
} from 'lucide-react';
import ImagePicker from '../../components/admin/ImagePicker';

interface Category {
    _id: string;
    name: string;
    slug: string;
    icon: string;
}

interface ServerOption {
    label: string;
    value: string;
}

type SectionId = 'identity' | 'description' | 'formConfig';

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
                <ChevronDown
                    className={`h-4 w-4 ui-text-muted transition-transform ${open ? 'rotate-180' : ''}`}
                />
            </button>
            {open ? <div className="border-t ui-border px-5 pb-5 pt-4">{children}</div> : null}
        </section>
    );
}

export default function ProductOperatorForm() {
    const navigate = useNavigate();
    const { id } = useParams();
    const [searchParams] = useSearchParams();
    const isEdit = Boolean(id);

    const [categories, setCategories] = useState<Category[]>([]);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
    const [openSections, setOpenSections] = useState<Record<SectionId, boolean>>({
        identity: true,
        description: true,
        formConfig: true,
    });

    const [formData, setFormData] = useState({
        name: '',
        categoryId: searchParams.get('category') || '',
        validationType: 'none',
        icon: '',
        instructionImage: '',
        status: true,
        description: '',
        isCustomProduct: false,
        userIdLabel: 'User ID',
        userIdType: 'number',
        hasServerId: false,
        serverIdLabel: 'Server ID',
        serverIdDropdown: false,
        serverIdType: 'number',
        serverOptions: [] as ServerOption[],
    });

    const [newServerLabel, setNewServerLabel] = useState('');
    const [newServerValue, setNewServerValue] = useState('');

    const [uploading, setUploading] = useState<string | null>(null);
    const [showIconPicker, setShowIconPicker] = useState(false);
    const [showInstructionPicker, setShowInstructionPicker] = useState(false);
    const latestOperatorRequestId = useRef(0);
    const navigateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const listPath = () => {
        const params = new URLSearchParams();
        const category = formData.categoryId || searchParams.get('category');
        if (category) params.set('category', category);
        const search = searchParams.get('search');
        const status = searchParams.get('status');
        if (search) params.set('search', search);
        if (status) params.set('status', status);
        const query = params.toString();
        return `/admin/product-operators${query ? `?${query}` : ''}`;
    };

    const toggleSection = (sectionId: SectionId) => {
        setOpenSections((current) => ({ ...current, [sectionId]: !current[sectionId] }));
    };

    useEffect(() => {
        // Keep create form category locked to the tab the user came from.
        const fromList = searchParams.get('category');
        if (!isEdit && fromList && !formData.categoryId) {
            setFormData((current) => ({ ...current, categoryId: fromList }));
        }
    }, [formData.categoryId, isEdit, searchParams]);

    useEffect(() => {
        fetchCategories();
        if (isEdit) {
            fetchOperator();
        }
        return () => {
            if (navigateTimeoutRef.current) {
                clearTimeout(navigateTimeoutRef.current);
            }
        };
    }, [id]);

    const fetchCategories = async () => {
        try {
            const res = await apiV2.get('/categories/admin/all');
            setCategories(res.data);
        } catch (error) {
            console.error('Failed to fetch categories', error);
            setMessage({ type: 'error', text: 'Gagal memuat kategori produk' });
        }
    };

    const fetchOperator = async () => {
        const requestId = latestOperatorRequestId.current + 1;
        latestOperatorRequestId.current = requestId;

        try {
            setLoading(true);
            const res = await apiV2.get(`/operators/admin/${id}`);
            if (requestId !== latestOperatorRequestId.current) return;
            const op = res.data;
            setFormData({
                name: op.name || '',
                categoryId: typeof op.categoryId === 'object' ? op.categoryId._id : op.categoryId || '',
                validationType: op.validationType || 'none',
                icon: op.icon || '',
                instructionImage: op.instructionImage || '',
                status: op.status ?? true,
                description: op.description || '',
                isCustomProduct: op.isCustomProduct || false,
                userIdLabel: op.userIdLabel || 'User ID',
                userIdType: op.userIdType || 'number',
                hasServerId: op.hasServerId || false,
                serverIdLabel: op.serverIdLabel || 'Server ID',
                serverIdDropdown: op.serverIdDropdown || false,
                serverIdType: op.serverIdType || 'number',
                serverOptions: op.serverOptions || [],
            });
        } catch (error) {
            if (requestId !== latestOperatorRequestId.current) return;
            console.error('Failed to fetch operator', error);
            setMessage({ type: 'error', text: 'Gagal memuat data operator' });
        } finally {
            if (requestId === latestOperatorRequestId.current) {
                setLoading(false);
            }
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setSaving(true);
        setMessage(null);
        if (!formData.name.trim() || !formData.categoryId) {
            setMessage({ type: 'error', text: 'Nama operator dan kategori wajib diisi' });
            setSaving(false);
            setOpenSections((current) => ({ ...current, identity: true }));
            return;
        }

        try {
            if (isEdit) {
                await apiV2.put(`/operators/admin/${id}`, formData);
                setMessage({ type: 'success', text: 'Operator berhasil diperbarui' });
            } else {
                await apiV2.post('/operators/admin/create', formData);
                setMessage({ type: 'success', text: 'Operator berhasil ditambahkan' });
            }
            if (navigateTimeoutRef.current) {
                clearTimeout(navigateTimeoutRef.current);
            }
            navigateTimeoutRef.current = setTimeout(() => navigate(listPath()), 900);
        } catch (error: any) {
            setMessage({ type: 'error', text: error.response?.data?.message || 'Gagal menyimpan operator' });
        } finally {
            setSaving(false);
        }
    };

    const addServerOption = () => {
        if (!newServerLabel.trim()) return;
        const value = newServerValue.trim() || newServerLabel.toLowerCase().replace(/\s+/g, '_');
        setFormData({
            ...formData,
            serverOptions: [...formData.serverOptions, { label: newServerLabel, value }],
        });
        setNewServerLabel('');
        setNewServerValue('');
    };

    const handleFileUpload = (field: 'icon' | 'instructionImage') => async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        const uploadType = field === 'icon' ? 'icons' : 'instructions';
        setUploading(field);

        try {
            const formDataUpload = new FormData();
            formDataUpload.append('file', file);

            const res = await apiV2.post(`/upload?type=${uploadType}`, formDataUpload, {
                headers: { 'Content-Type': 'multipart/form-data' },
            });

            if (res.data.success) {
                setFormData({ ...formData, [field]: res.data.url });
            }
        } catch (error) {
            console.error('Upload failed:', error);
            setMessage({ type: 'error', text: 'Gagal upload file' });
        } finally {
            setUploading(null);
        }
    };

    const removeServerOption = (index: number) => {
        setFormData({
            ...formData,
            serverOptions: formData.serverOptions.filter((_, i) => i !== index),
        });
    };

    const canSave = Boolean(formData.name.trim() && formData.categoryId) && !saving;
    const selectedCategoryName = categories.find((cat) => cat._id === formData.categoryId)?.name;

    if (loading) {
        return (
            <div className="flex min-h-[50vh] items-center justify-center">
                <div className="flex flex-col items-center gap-2">
                    <Loader2 className="w-8 h-8 ui-accent-text animate-spin" />
                    <p className="ui-text-muted text-sm">Memuat data operator...</p>
                </div>
            </div>
        );
    }

    return (
        <div className="mx-auto w-full max-w-6xl space-y-4 pb-28">
            {/* Sticky page header + save */}
            <div className="sticky top-0 z-20 -mx-1 border-b ui-border bg-[color-mix(in_srgb,var(--ui-panel)_92%,transparent)] px-1 py-3 backdrop-blur supports-[backdrop-filter]:bg-[color-mix(in_srgb,var(--ui-panel)_78%,transparent)]">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                        <button
                            type="button"
                            onClick={() => navigate(listPath())}
                            className="mb-1 inline-flex items-center gap-2 text-sm ui-text-muted hover:text-[var(--ui-text)] transition-colors"
                        >
                            <ArrowLeft className="w-4 h-4" />
                            Kembali ke Daftar Operator
                        </button>
                        <h1 className="truncate text-xl font-black ui-text sm:text-2xl">
                            {isEdit ? 'Edit Operator' : 'Tambah Operator'}
                        </h1>
                        <p className="mt-0.5 text-xs ui-text-muted">
                            {selectedCategoryName
                                ? `Kategori: ${selectedCategoryName}`
                                : 'Lengkapi identitas, lalu konfigurasi form order.'}
                            {!isEdit && searchParams.get('category')
                                ? ' · Kategori dari tab list ikut terbawa.'
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
                            className="ui-muted-action rounded-xl border px-4 py-2.5 text-sm font-semibold"
                        >
                            Batal
                        </button>
                        <button
                            type="submit"
                            form="product-operator-form"
                            disabled={!canSave}
                            className="ui-accent-solid inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                            {saving ? 'Menyimpan…' : 'Simpan'}
                        </button>
                    </div>
                </div>
            </div>

            <form id="product-operator-form" onSubmit={handleSubmit} className="space-y-4">
                <FormSection
                    id="identity"
                    title="1. Identitas Operator"
                    icon={Tag}
                    open={openSections.identity}
                    onToggle={toggleSection}
                >
                    <div className="space-y-5">
                        <div>
                            <label className="block text-xs font-medium ui-text-muted mb-1.5 uppercase tracking-wide">
                                Nama Operator
                            </label>
                            <input
                                type="text"
                                required
                                value={formData.name}
                                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                                className="block w-full border ui-border rounded-lg py-2.5 px-4 ui-panel-muted ui-text focus:ring-1 focus:ring-[var(--ui-accent)] focus:border-[var(--ui-accent)] text-sm placeholder-[var(--ui-text-muted)] transition-all"
                                placeholder="Contoh: Genshin Impact"
                            />
                        </div>

                        <div>
                            <label className="block text-xs font-medium ui-text-muted mb-1.5 uppercase tracking-wide">
                                Kategori Produk
                            </label>
                            <select
                                required
                                value={formData.categoryId}
                                onChange={(e) => setFormData({ ...formData, categoryId: e.target.value })}
                                className="block w-full border ui-border rounded-lg py-2.5 px-4 ui-panel-muted ui-text focus:ring-1 focus:ring-[var(--ui-accent)] focus:border-[var(--ui-accent)] text-sm transition-all"
                            >
                                <option value="">Pilih Kategori...</option>
                                {categories.map((cat) => (
                                    <option key={cat._id} value={cat._id}>
                                        {cat.name}
                                    </option>
                                ))}
                            </select>
                            {!formData.categoryId && (
                                <p className="mt-1.5 text-xs ui-warning-text">
                                    Pilih kategori dulu (atau buka Tambah dari tab kategori di list).
                                </p>
                            )}
                        </div>

                        <div>
                            <label className="block text-xs font-medium ui-text-muted mb-2 uppercase tracking-wide">
                                Icon Operator
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
                            <label className="block text-xs font-medium ui-text-muted mb-1.5 uppercase tracking-wide">
                                Status Publikasi
                            </label>
                            <label className="flex items-center p-3 ui-panel-muted rounded-lg border ui-border cursor-pointer hover:border-[var(--ui-accent)]/50 transition-colors w-full">
                                <div className="relative inline-flex items-center cursor-pointer">
                                    <input
                                        type="checkbox"
                                        className="sr-only peer"
                                        checked={formData.status}
                                        onChange={(e) => setFormData({ ...formData, status: e.target.checked })}
                                    />
                                    <div className="w-11 h-6 ui-panel-muted peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-[var(--ui-card-bg)] after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-[var(--ui-card-bg)] after:ui-border after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[var(--ui-accent)]"></div>
                                </div>
                                <span className={`ml-3 text-sm font-medium ${formData.status ? 'ui-success-text' : 'ui-text-muted'}`}>
                                    {formData.status ? 'Operator Aktif (Tampil)' : 'Operator Non-Aktif (Sembunyi)'}
                                </span>
                            </label>
                        </div>
                    </div>
                </FormSection>

                <FormSection
                    id="description"
                    title="2. Deskripsi & Petunjuk"
                    icon={FileText}
                    open={openSections.description}
                    onToggle={toggleSection}
                >
                    <div className="space-y-4">
                        <div>
                            <label className="block text-xs font-medium ui-text-muted mb-2 uppercase tracking-wide">
                                Gambar Petunjuk (Opsional)
                            </label>
                            <div className="flex gap-3">
                                <div className="flex-1 space-y-2">
                                    <input
                                        type="text"
                                        value={formData.instructionImage}
                                        onChange={(e) => setFormData({ ...formData, instructionImage: e.target.value })}
                                        className="block w-full border ui-border rounded-lg py-2 px-3 ui-panel-muted ui-text text-sm"
                                        placeholder="URL gambar..."
                                    />
                                    <div className="flex flex-wrap gap-2">
                                        <button
                                            type="button"
                                            onClick={() => setShowInstructionPicker(true)}
                                            className="flex items-center gap-2 px-4 py-2 ui-accent-chip border border-[color-mix(in_srgb,var(--ui-accent)_34%,transparent)] rounded-lg text-xs ui-accent-text hover:text-[var(--ui-accent-strong)] transition-all"
                                        >
                                            <FolderOpen className="w-3 h-3" />
                                            Pilih dari Galeri
                                        </button>
                                        <label
                                            className={`inline-flex items-center px-4 py-2 ui-panel-muted ui-text-muted rounded-lg text-xs font-medium hover:bg-[var(--ui-panel-muted)] hover:text-[var(--ui-text)] cursor-pointer transition-colors ${
                                                uploading === 'instructionImage' ? 'opacity-50' : ''
                                            }`}
                                        >
                                            {uploading === 'instructionImage' ? (
                                                <Loader2 className="w-3 h-3 animate-spin mr-2" />
                                            ) : (
                                                <Upload className="w-3 h-3 mr-2" />
                                            )}
                                            Upload Baru
                                            <input
                                                type="file"
                                                accept="image/*"
                                                className="hidden"
                                                onChange={handleFileUpload('instructionImage')}
                                                disabled={uploading === 'instructionImage'}
                                            />
                                        </label>
                                    </div>
                                </div>
                                {formData.instructionImage && (
                                    <div className="w-32 rounded-lg border ui-border ui-panel-muted overflow-hidden relative group">
                                        <img src={formData.instructionImage} alt="instruction" className="w-full h-full object-cover" />
                                        <button
                                            type="button"
                                            onClick={() => setFormData({ ...formData, instructionImage: '' })}
                                            className="ui-danger-action absolute top-1 right-1 rounded-md p-1 opacity-0 transition-opacity group-hover:opacity-100"
                                        >
                                            <X className="w-3 h-3" />
                                        </button>
                                    </div>
                                )}
                            </div>
                        </div>

                        <div>
                            <label className="block text-xs font-medium ui-text-muted mb-1.5 uppercase tracking-wide">
                                Deskripsi Text
                            </label>
                            <textarea
                                value={formData.description}
                                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                                rows={5}
                                className="block w-full border ui-border rounded-lg py-3 px-4 ui-panel-muted ui-text focus:ring-1 focus:ring-[var(--ui-accent)] focus:border-[var(--ui-accent)] text-sm placeholder-[var(--ui-text-muted)] resize-y"
                                placeholder="Contoh: Masukkan ID (Server) untuk topup Genshin Impact..."
                            />
                        </div>
                    </div>
                </FormSection>

                <FormSection
                    id="formConfig"
                    title="3. Konfigurasi Form Order"
                    icon={Settings}
                    open={openSections.formConfig}
                    onToggle={toggleSection}
                >
                    <div className="space-y-6">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <p className="text-sm ui-text-muted">Atur field yang diisi pembeli saat order.</p>
                            <label className="inline-flex items-center gap-2 text-xs font-medium ui-text-muted cursor-pointer select-none">
                                <input
                                    type="checkbox"
                                    id="isCustomProduct"
                                    checked={formData.isCustomProduct}
                                    onChange={(e) => setFormData({ ...formData, isCustomProduct: e.target.checked })}
                                    className="w-4 h-4 ui-accent-text ui-panel-muted ui-border rounded"
                                />
                                Produk Custom
                            </label>
                        </div>

                        <div>
                            <label className="block text-xs font-medium ui-text-muted mb-2 uppercase tracking-wide">
                                Sistem Validasi ID
                            </label>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                {[
                                    { id: 'none', label: 'Tanpa Validasi', icon: Shield },
                                    { id: 'freefire', label: 'Free Fire', icon: CheckCircle },
                                    { id: 'mobilelegends', label: 'Mobile Legends', icon: CheckCircle },
                                    { id: 'operator', label: 'Cek No. HP', icon: Database },
                                ].map((v) => (
                                    <button
                                        key={v.id}
                                        type="button"
                                        role="radio"
                                        aria-checked={formData.validationType === v.id}
                                        onClick={() => setFormData({ ...formData, validationType: v.id })}
                                        className={`cursor-pointer border rounded-lg p-3 flex items-center gap-3 transition-all text-left ${
                                            formData.validationType === v.id
                                                ? 'bg-[var(--ui-accent-soft)] border-[var(--ui-accent)] ring-1 ring-[var(--ui-accent)]'
                                                : 'ui-panel-muted ui-border hover:bg-[var(--ui-panel-muted)]'
                                        }`}
                                    >
                                        <v.icon
                                            className={`w-4 h-4 ${
                                                formData.validationType === v.id ? 'ui-accent-text' : 'ui-text-muted'
                                            }`}
                                        />
                                        <span
                                            className={`text-sm font-medium ${
                                                formData.validationType === v.id ? 'ui-accent-text' : 'ui-text-muted'
                                            }`}
                                        >
                                            {v.label}
                                        </span>
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div className="p-4 ui-panel-muted rounded-xl border ui-border">
                            <label className="block text-xs font-bold ui-text mb-3 flex items-center gap-2">
                                <span className="w-1.5 h-1.5 rounded-full bg-[var(--ui-info)]"></span>
                                Input Utama (User ID / No. HP)
                            </label>
                            <div className="grid grid-cols-3 gap-3">
                                <div className="col-span-2">
                                    <label className="text-[10px] ui-text-muted mb-1 block">Label Input</label>
                                    <input
                                        type="text"
                                        value={formData.userIdLabel}
                                        onChange={(e) => setFormData({ ...formData, userIdLabel: e.target.value })}
                                        className="block w-full border ui-border rounded-lg py-2 px-3 ui-panel ui-text text-sm focus:border-[var(--ui-accent)]"
                                        placeholder="Contoh: User ID"
                                    />
                                </div>
                                <div>
                                    <label className="text-[10px] ui-text-muted mb-1 block">Tipe Input</label>
                                    <select
                                        value={formData.userIdType}
                                        onChange={(e) => setFormData({ ...formData, userIdType: e.target.value })}
                                        className="block w-full border ui-border rounded-lg py-2 px-3 ui-panel ui-text text-sm focus:border-[var(--ui-accent)]"
                                    >
                                        <option value="number">Angka</option>
                                        <option value="text">Text</option>
                                        <option value="email">Email</option>
                                    </select>
                                </div>
                            </div>
                        </div>

                        <div className="p-4 ui-panel-muted rounded-xl border ui-border">
                            <div className="flex items-center justify-between mb-3">
                                <label className="text-xs font-bold ui-text flex items-center gap-2">
                                    <span className="w-1.5 h-1.5 rounded-full bg-[var(--ui-accent)]"></span>
                                    Input Kedua (Server ID / Zone)
                                </label>
                                <label className="inline-flex items-center cursor-pointer">
                                    <span className="mr-2 text-[10px] ui-text-muted font-medium">Aktifkan?</span>
                                    <div className="relative inline-flex items-center cursor-pointer">
                                        <input
                                            type="checkbox"
                                            className="sr-only peer"
                                            checked={formData.hasServerId}
                                            onChange={(e) => setFormData({ ...formData, hasServerId: e.target.checked })}
                                        />
                                        <div className="w-9 h-5 ui-panel-muted peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-[var(--ui-card-bg)] after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-[var(--ui-card-bg)] after:ui-border after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[var(--ui-accent)]"></div>
                                    </div>
                                </label>
                            </div>

                            {formData.hasServerId && (
                                <div className="space-y-4">
                                    <div className="grid grid-cols-3 gap-3">
                                        <div className="col-span-2">
                                            <label className="text-[10px] ui-text-muted mb-1 block">Label Input</label>
                                            <input
                                                type="text"
                                                value={formData.serverIdLabel}
                                                onChange={(e) => setFormData({ ...formData, serverIdLabel: e.target.value })}
                                                className="block w-full border ui-border rounded-lg py-2 px-3 ui-panel ui-text text-sm focus:border-[var(--ui-accent)]"
                                                placeholder="Contoh: Server ID"
                                            />
                                        </div>
                                        <div>
                                            <label className="text-[10px] ui-text-muted mb-1 block">Tipe Input</label>
                                            <select
                                                value={formData.serverIdType}
                                                onChange={(e) => setFormData({ ...formData, serverIdType: e.target.value })}
                                                className="block w-full border ui-border rounded-lg py-2 px-3 ui-panel ui-text text-sm focus:border-[var(--ui-accent)]"
                                            >
                                                <option value="number">Angka</option>
                                                <option value="text">Text</option>
                                            </select>
                                        </div>
                                    </div>

                                    <div className="border-t ui-border pt-3 mt-3">
                                        <label className="flex items-center gap-2 mb-3">
                                            <input
                                                type="checkbox"
                                                checked={formData.serverIdDropdown}
                                                onChange={(e) => setFormData({ ...formData, serverIdDropdown: e.target.checked })}
                                                className="w-3.5 h-3.5 ui-accent-text ui-panel ui-border rounded"
                                            />
                                            <span className="text-xs ui-text-muted">Gunakan Dropdown List untuk Server</span>
                                        </label>

                                        {formData.serverIdDropdown && (
                                            <div className="ui-panel p-3 rounded-lg border ui-border">
                                                <div className="flex flex-col gap-2 mb-3 sm:flex-row">
                                                    <input
                                                        type="text"
                                                        value={newServerLabel}
                                                        onChange={(e) => setNewServerLabel(e.target.value)}
                                                        className="flex-1 w-full border ui-border rounded px-2 py-1.5 ui-panel-muted ui-text text-xs"
                                                        placeholder="Label (ex: Asia)"
                                                    />
                                                    <input
                                                        type="text"
                                                        value={newServerValue}
                                                        onChange={(e) => setNewServerValue(e.target.value)}
                                                        className="flex-1 w-full border ui-border rounded px-2 py-1.5 ui-panel-muted ui-text text-xs"
                                                        placeholder="Value (ex: os_asia)"
                                                    />
                                                    <button
                                                        type="button"
                                                        onClick={addServerOption}
                                                        className="ui-accent-chip rounded border px-3 py-1.5 text-xs font-semibold"
                                                    >
                                                        Add
                                                    </button>
                                                </div>

                                                {formData.serverOptions.length > 0 ? (
                                                    <div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto">
                                                        {formData.serverOptions.map((opt, idx) => (
                                                            <span
                                                                key={idx}
                                                                className="inline-flex items-center gap-1 px-2 py-1 ui-panel-muted border ui-border rounded text-[10px] ui-text-muted"
                                                            >
                                                                {opt.label}
                                                                <button
                                                                    type="button"
                                                                    onClick={() => removeServerOption(idx)}
                                                                    className="ui-text-muted hover:text-[var(--ui-danger)]"
                                                                >
                                                                    <X className="w-3 h-3" />
                                                                </button>
                                                            </span>
                                                        ))}
                                                    </div>
                                                ) : (
                                                    <p className="text-[10px] ui-text-muted text-center py-2">Belum ada data server</p>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </FormSection>
            </form>

            {/* Sticky bottom save bar (mobile-friendly) */}
            <div className="fixed inset-x-0 bottom-0 z-20 border-t ui-border bg-[color-mix(in_srgb,var(--ui-panel)_94%,transparent)] px-4 py-3 backdrop-blur sm:px-6">
                <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-xs ui-text-muted">
                        {canSave
                            ? isEdit
                                ? 'Perubahan siap disimpan.'
                                : 'Siap menambah operator ke kategori terpilih.'
                            : 'Lengkapi nama & kategori di bagian Identitas.'}
                    </p>
                    <div className="flex gap-2">
                        <button
                            type="button"
                            onClick={() => navigate(listPath())}
                            className="ui-muted-action flex-1 rounded-xl border px-4 py-2.5 text-sm font-semibold sm:flex-none"
                        >
                            Batal
                        </button>
                        <button
                            type="submit"
                            form="product-operator-form"
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
                title="Pilih Icon Operator"
            />
            <ImagePicker
                isOpen={showInstructionPicker}
                onClose={() => setShowInstructionPicker(false)}
                onSelect={(url) => setFormData({ ...formData, instructionImage: url })}
                currentValue={formData.instructionImage}
                type="instructions"
                title="Pilih Gambar Petunjuk"
            />
        </div>
    );
}
