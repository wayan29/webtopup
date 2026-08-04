import { useEffect, useMemo, useRef, useState } from 'react';
import {
    AlertTriangle,
    Edit,
    Eye,
    EyeOff,
    ExternalLink,
    GripVertical,
    Image as ImageIcon,
    Link2,
    Plus,
    RotateCcw,
    Search,
    Trash2,
    X
} from 'lucide-react';
import { apiV2 } from '../../api';
import ImagePickerField from '../../components/admin/ImagePickerField';
import { getAssetUrl } from '../../lib/assetUrl';
import {
    DndContext,
    KeyboardSensor,
    PointerSensor,
    closestCenter,
    useSensor,
    useSensors
} from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import {
    SortableContext,
    arrayMove,
    sortableKeyboardCoordinates,
    useSortable,
    verticalListSortingStrategy
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

interface Slider {
    _id: string;
    name: string;
    image: string;
    link: string;
    sortOrder: number;
    status: boolean;
}

interface SliderFormData {
    name: string;
    image: string;
    link: string;
    status: boolean;
}

type StatusFilter = 'all' | 'active' | 'inactive';

const defaultForm: SliderFormData = {
    name: '',
    image: '',
    link: '',
    status: true
};

const getImageUrl = (image: string) => {
    if (!image) {
        return '';
    }

    if (image.startsWith('http')) {
        return image;
    }

    return getAssetUrl(image);
};

const getSafeSliderLink = (link?: string | null) => {
    const normalized = typeof link === 'string' ? link.trim() : '';

    if (!normalized) {
        return null;
    }

    if (/[\r\n\t]/.test(normalized)) {
        return null;
    }

    if (normalized.startsWith('/')) {
        return normalized.startsWith('//') || normalized.startsWith('/\\') ? null : normalized;
    }

    try {
        const parsed = new URL(normalized);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:'
            ? parsed.toString()
            : null;
    } catch {
        return null;
    }
};

const getLinkMeta = (link?: string | null) => {
    const normalized = typeof link === 'string' ? link.trim() : '';

    if (!normalized) {
        return {
            safeLink: null,
            label: '-',
            caption: 'Tanpa link',
            invalid: false,
            external: false
        };
    }

    const safeLink = getSafeSliderLink(normalized);
    if (!safeLink) {
        return {
            safeLink: null,
            label: 'Link tidak valid',
            caption: normalized,
            invalid: true,
            external: false
        };
    }

    if (safeLink.startsWith('/')) {
        return {
            safeLink,
            label: 'Internal',
            caption: safeLink,
            invalid: false,
            external: false
        };
    }

    const parsed = new URL(safeLink);
    return {
        safeLink,
        label: parsed.hostname,
        caption: `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`,
        invalid: false,
        external: true
    };
};

function SortableRow({
    slider,
    index,
    dragEnabled,
    busyId,
    onEdit,
    onDelete,
    onToggleStatus
}: {
    slider: Slider;
    index: number;
    dragEnabled: boolean;
    busyId: string | null;
    onEdit: (slider: Slider) => void;
    onDelete: (slider: Slider) => void;
    onToggleStatus: (slider: Slider) => void;
}) {
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging
    } = useSortable({
        id: slider._id,
        disabled: !dragEnabled
    });

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1
    };

    const linkMeta = getLinkMeta(slider.link);
    const isBusy = busyId === slider._id;

    return (
        <tr ref={setNodeRef} style={style} className="hover:bg-[var(--ui-card-bg)] align-top">
            <td className="px-4 py-3 text-sm ui-text-muted">
                <button
                    {...attributes}
                    {...listeners}
                    disabled={!dragEnabled}
                    className={`rounded p-1 ${
                        dragEnabled
                            ? 'cursor-grab active:cursor-grabbing hover:bg-[var(--ui-card-muted)]'
                            : 'cursor-not-allowed opacity-40'
                    }`}
                    title={dragEnabled ? 'Drag untuk ubah urutan' : 'Reorder dinonaktifkan saat filter aktif atau sedang menyimpan'}
                >
                    <GripVertical className="w-4 h-4" />
                </button>
            </td>
            <td className="px-4 py-3 text-sm ui-text">
                <div className="font-semibold">#{index + 1}</div>
                <div className="text-xs ui-text-muted">Urutan {slider.sortOrder + 1}</div>
            </td>
            <td className="px-4 py-3 text-sm ui-text">
                <div className="font-semibold">{slider.name}</div>
                <div className="text-xs ui-text-muted break-all">{slider._id}</div>
            </td>
            <td className="px-4 py-3 text-sm">
                <div className="overflow-hidden rounded-lg border ui-border ui-panel">
                    {slider.image ? (
                        <img
                            src={getImageUrl(slider.image)}
                            alt={slider.name}
                            className="h-16 w-40 object-cover"
                        />
                    ) : (
                        <div className="flex h-16 w-40 items-center justify-center ui-text-muted">
                            <ImageIcon className="w-5 h-5" />
                        </div>
                    )}
                </div>
            </td>
            <td className="px-4 py-3 text-sm">
                {linkMeta.safeLink ? (
                    <a
                        href={linkMeta.safeLink}
                        className="inline-flex flex-col rounded-lg border ui-border ui-panel px-3 py-2 text-left hover:bg-[var(--ui-card-muted)]"
                        target={linkMeta.external ? '_blank' : undefined}
                        rel={linkMeta.external ? 'noopener noreferrer' : undefined}
                    >
                        <span className="inline-flex items-center gap-1 font-semibold ui-text">
                            {linkMeta.label}
                            {linkMeta.external ? <ExternalLink className="w-3.5 h-3.5" /> : null}
                        </span>
                        <span className="max-w-[180px] truncate text-xs ui-text-muted">{linkMeta.caption}</span>
                    </a>
                ) : linkMeta.invalid ? (
                    <div className="rounded-lg border px-3 py-2 text-xs ui-danger-chip">
                        <div className="font-semibold">{linkMeta.label}</div>
                        <div className="mt-1 break-all opacity-80">{linkMeta.caption}</div>
                    </div>
                ) : (
                    <span className="ui-text-muted">-</span>
                )}
            </td>
            <td className="px-4 py-3 text-sm">
                <span className={`inline-flex rounded-full border px-2 py-1 text-xs font-semibold ${slider.status ? 'ui-success-chip' : 'ui-danger-chip'}`}>
                    {slider.status ? 'Aktif' : 'Nonaktif'}
                </span>
            </td>
            <td className="px-4 py-3 text-sm ui-text">
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => onEdit(slider)}
                        disabled={isBusy}
                        className="rounded p-1.5 ui-info-chip disabled:opacity-50"
                        title="Edit"
                    >
                        <Edit className="w-4 h-4" />
                    </button>
                    <button
                        onClick={() => onToggleStatus(slider)}
                        disabled={isBusy}
                        className={`rounded p-1.5 disabled:opacity-50 ${
                            slider.status
                                ? 'ui-warning-chip'
                                : 'ui-success-chip'
                        }`}
                        title={slider.status ? 'Nonaktifkan' : 'Aktifkan'}
                    >
                        {slider.status ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                    <button
                        onClick={() => onDelete(slider)}
                        disabled={isBusy}
                        className="rounded p-1.5 ui-danger-action disabled:opacity-50"
                        title="Hapus"
                    >
                        <Trash2 className="w-4 h-4" />
                    </button>
                </div>
            </td>
        </tr>
    );
}

export default function Sliders() {
    const [sliders, setSliders] = useState<Slider[]>([]);
    const [loading, setLoading] = useState(true);
    const [showModal, setShowModal] = useState(false);
    const [editingSlider, setEditingSlider] = useState<Slider | null>(null);
    const [form, setForm] = useState<SliderFormData>(defaultForm);
    const [saving, setSaving] = useState(false);
    const [sorting, setSorting] = useState(false);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [search, setSearch] = useState('');
    const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<Slider | null>(null);
    const latestRequestId = useRef(0);

    const sensors = useSensors(
        useSensor(PointerSensor),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates
        })
    );

    const fetchSliders = async () => {
        const requestId = latestRequestId.current + 1;
        latestRequestId.current = requestId;
        try {
            setLoading(true);
            const response = await apiV2
                .get('/sliders/admin/all');
            if (requestId !== latestRequestId.current) return;
            setSliders(response.data || []);
        } catch (error: any) {
            if (requestId !== latestRequestId.current) return;
            console.error('Failed to load sliders', error);
            setMessage({
                type: 'error',
                text: error.response?.data?.message || 'Gagal memuat daftar slider'
            });
        } finally {
            if (requestId === latestRequestId.current) {
                setLoading(false);
            }
        }
    };

    useEffect(() => {
        fetchSliders();
        const handleRefresh = () => fetchSliders();
        window.addEventListener('admin:refresh-current-page', handleRefresh);
        return () => window.removeEventListener('admin:refresh-current-page', handleRefresh);
    }, []);

    const filteredSliders = useMemo(() => {
        const keyword = search.trim().toLowerCase();

        return sliders.filter((slider) => {
            const linkMeta = getLinkMeta(slider.link);
            const matchesSearch =
                !keyword ||
                slider.name.toLowerCase().includes(keyword) ||
                slider.link.toLowerCase().includes(keyword) ||
                linkMeta.caption.toLowerCase().includes(keyword);

            const matchesStatus =
                statusFilter === 'all' ||
                (statusFilter === 'active' ? slider.status : !slider.status);

            return matchesSearch && matchesStatus;
        });
    }, [sliders, search, statusFilter]);

    const summary = useMemo(() => {
        return sliders.reduce(
            (result, slider) => {
                result.total += 1;
                result.active += slider.status ? 1 : 0;
                result.inactive += slider.status ? 0 : 1;
                result.withLink += slider.link.trim() ? 1 : 0;
                result.invalidLink += slider.link.trim() && !getSafeSliderLink(slider.link) ? 1 : 0;
                return result;
            },
            {
                total: 0,
                active: 0,
                inactive: 0,
                withLink: 0,
                invalidLink: 0
            }
        );
    }, [sliders]);

    const canReorder = search.trim() === '' && statusFilter === 'all' && !sorting && !busyId && !saving;
    const formLinkMeta = getLinkMeta(form.link);

    const validateForm = () => {
        if (!form.name.trim()) {
            return 'Nama slider wajib diisi';
        }

        if (!form.image.trim()) {
            return 'Gambar slider wajib diisi';
        }

        if (form.link.trim() && !getSafeSliderLink(form.link)) {
            return 'Link slider harus berupa URL http/https atau path internal yang diawali "/"';
        }

        return null;
    };

    const handleDragEnd = async (event: DragEndEvent) => {
        if (!canReorder) {
            return;
        }

        const { active, over } = event;
        if (!over || active.id === over.id) {
            return;
        }

        const oldIndex = sliders.findIndex((slider) => slider._id === active.id);
        const newIndex = sliders.findIndex((slider) => slider._id === over.id);

        if (oldIndex === -1 || newIndex === -1) {
            return;
        }

        const reordered = arrayMove(sliders, oldIndex, newIndex).map((slider, index) => ({
            ...slider,
            sortOrder: index
        }));

        setSliders(reordered);
        setSorting(true);
        setMessage(null);

        try {
            const orders = reordered.map((slider, index) => ({
                id: slider._id,
                sortOrder: index
            }));

            await apiV2.put('/sliders/admin/sort-order', { orders });
            setMessage({ type: 'success', text: 'Urutan slider berhasil diperbarui' });
        } catch (error: any) {
            console.error('Failed to update sort order', error);
            setMessage({
                type: 'error',
                text: error.response?.data?.message || 'Gagal memperbarui urutan slider'
            });
            await fetchSliders();
        } finally {
            setSorting(false);
        }
    };

    const handleSubmit = async (event: React.FormEvent) => {
        event.preventDefault();

        const validationError = validateForm();
        if (validationError) {
            setMessage({ type: 'error', text: validationError });
            return;
        }

        const payload = {
            name: form.name.trim(),
            image: form.image.trim(),
            link: form.link.trim(),
            status: form.status
        };

        setSaving(true);
        setMessage(null);

        try {
            if (editingSlider) {
                await apiV2.put(`/sliders/admin/${editingSlider._id}`, payload)
                setMessage({ type: 'success', text: 'Slider berhasil diperbarui' });
            } else {
                await apiV2.post('/sliders/admin/create', payload)
                setMessage({ type: 'success', text: 'Slider berhasil ditambahkan' });
            }

            await fetchSliders();
            setShowModal(false);
            setForm(defaultForm);
            setEditingSlider(null);
        } catch (error: any) {
            console.error('Failed to save slider', error);
            setMessage({
                type: 'error',
                text: error.response?.data?.message || 'Gagal menyimpan slider'
            });
        } finally {
            setSaving(false);
        }
    };

    const handleEdit = (slider: Slider) => {
        setEditingSlider(slider);
        setForm({
            name: slider.name,
            image: slider.image,
            link: slider.link || '',
            status: slider.status
        });
        setShowModal(true);
    };

    const handleDelete = (slider: Slider) => {
        setDeleteTarget(slider);
    };

    const confirmDelete = async () => {
        if (!deleteTarget) return;
        const slider = deleteTarget;
        setBusyId(slider._id);
        setMessage(null);

        try {
            await apiV2.delete(`/sliders/admin/${slider._id}`);
            setMessage({ type: 'success', text: `Slider "${slider.name}" berhasil dihapus` });
            setDeleteTarget(null);
            await fetchSliders();
        } catch (error: any) {
            console.error('Failed to delete slider', error);
            setMessage({
                type: 'error',
                text: error.response?.data?.message || 'Gagal menghapus slider'
            });
        } finally {
            setBusyId(null);
        }
    };

    const handleToggleStatus = async (slider: Slider) => {
        setBusyId(slider._id);
        setMessage(null);

        try {
            await apiV2.put(`/sliders/admin/${slider._id}`, { status: !slider.status });
            setMessage({
                type: 'success',
                text: `Slider "${slider.name}" ${slider.status ? 'dinonaktifkan' : 'diaktifkan'}`
            });
            await fetchSliders();
        } catch (error: any) {
            console.error('Failed to toggle status', error);
            setMessage({
                type: 'error',
                text: error.response?.data?.message || 'Gagal mengubah status slider'
            });
        } finally {
            setBusyId(null);
        }
    };

    const openAddModal = () => {
        setEditingSlider(null);
        setForm(defaultForm);
        setShowModal(true);
    };

    const inputClass = 'w-full rounded-lg border px-3 py-2 text-sm ui-field';
    const labelClass = 'block text-sm font-medium ui-text mb-1';

    return (
        <div className="space-y-5">
            <div className="ui-panel-muted border ui-border rounded-xl p-4 flex flex-wrap gap-2">
                <button
                    onClick={openAddModal}
                    className="inline-flex items-center gap-2 rounded-xl ui-accent-solid px-4 py-2.5 text-sm font-semibold transition-colors"
                >
                    <Plus className="w-4 h-4" />
                    Tambah Slider
                </button>
            </div>

            {message ? (
                <div
                    className={`rounded-xl border px-4 py-3 text-sm ${
                        message.type === 'success'
                            ? 'ui-success-chip'
                            : 'ui-danger-chip'
                    }`}
                >
                    {message.text}
                </div>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-2xl border ui-border ui-panel-muted p-4">
                    <p className="text-[11px] uppercase tracking-[0.18em] ui-text-muted">Total Slider</p>
                    <p className="mt-2 text-3xl font-black ui-text">{summary.total}</p>
                    <p className="mt-1 text-sm ui-text-muted">{summary.active} aktif</p>
                </div>
                <div className="rounded-2xl border ui-border ui-panel-muted p-4">
                    <p className="text-[11px] uppercase tracking-[0.18em] ui-text-muted">Aktif</p>
                    <p className="mt-2 text-3xl font-black ui-text">{summary.active}</p>
                    <p className="mt-1 text-sm ui-text-muted">{summary.inactive} nonaktif</p>
                </div>
                <div className="rounded-2xl border ui-border ui-panel-muted p-4">
                    <p className="text-[11px] uppercase tracking-[0.18em] ui-text-muted">Pakai Link</p>
                    <p className="mt-2 text-3xl font-black ui-text">{summary.withLink}</p>
                    <p className="mt-1 text-sm ui-text-muted">{summary.total - summary.withLink} tanpa link</p>
                </div>
                <div className="rounded-2xl border ui-border ui-panel-muted p-4">
                    <p className="text-[11px] uppercase tracking-[0.18em] ui-text-muted">Perlu Dicek</p>
                    <p className="mt-2 text-3xl font-black ui-text">{summary.invalidLink}</p>
                    <p className="mt-1 text-sm ui-text-muted">link tidak valid</p>
                </div>
            </div>

            <div className="rounded-xl border ui-border ui-panel-muted p-4 space-y-4">
                <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px_auto]">
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ui-text-muted" />
                        <input
                            type="text"
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                            className={`${inputClass} pl-9`}
                            placeholder="Cari nama slider atau link..."
                        />
                    </div>
                    <select
                        value={statusFilter}
                        onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
                        className={inputClass}
                    >
                        <option value="all">Semua Status</option>
                        <option value="active">Aktif</option>
                        <option value="inactive">Nonaktif</option>
                    </select>
                    <button
                        onClick={() => {
                            setSearch('');
                            setStatusFilter('all');
                        }}
                        className="inline-flex items-center justify-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold ui-muted-action"
                    >
                        <RotateCcw className="w-4 h-4" />
                        Reset
                    </button>
                </div>
                <div className="flex flex-wrap items-center gap-3 text-sm ui-text-muted">
                    <span>{filteredSliders.length} slider tampil</span>
                    {!canReorder ? (
                        <span className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs ui-warning-chip">
                            <AlertTriangle className="w-3.5 h-3.5" />
                            Reorder dinonaktifkan saat filter aktif atau saat penyimpanan urutan berjalan.
                        </span>
                    ) : (
                        <span className="rounded-full border ui-border px-3 py-1 text-xs">
                            Drag & drop aktif
                        </span>
                    )}
                </div>
            </div>

            <div className="rounded-xl border ui-border ui-panel-muted overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="min-w-full">
                        <thead>
                            <tr className="ui-panel text-xs uppercase ui-text-muted">
                                <th className="px-4 py-3 text-left font-semibold w-12"></th>
                                <th className="px-4 py-3 text-left font-semibold">Urutan</th>
                                <th className="px-4 py-3 text-left font-semibold">Nama</th>
                                <th className="px-4 py-3 text-left font-semibold">Image</th>
                                <th className="px-4 py-3 text-left font-semibold">Link</th>
                                <th className="px-4 py-3 text-left font-semibold">Status</th>
                                <th className="px-4 py-3 text-left font-semibold">Aksi</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y ui-border">
                            {loading ? (
                                <tr>
                                    <td colSpan={7} className="px-4 py-10 text-center ui-text-muted">Memuat slider...</td>
                                </tr>
                            ) : filteredSliders.length === 0 ? (
                                <tr>
                                    <td colSpan={7} className="px-4 py-10 text-center ui-text-muted">Tidak ada slider yang cocok.</td>
                                </tr>
                            ) : (
                                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                                    <SortableContext items={filteredSliders.map((slider) => slider._id)} strategy={verticalListSortingStrategy}>
                                        {filteredSliders.map((slider, index) => (
                                            <SortableRow
                                                key={slider._id}
                                                slider={slider}
                                                index={index}
                                                dragEnabled={canReorder}
                                                busyId={busyId}
                                                onEdit={handleEdit}
                                                onDelete={handleDelete}
                                                onToggleStatus={handleToggleStatus}
                                            />
                                        ))}
                                    </SortableContext>
                                </DndContext>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {deleteTarget ? (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
                    <div role="dialog" aria-modal="true" aria-labelledby="delete-slider-title" className="w-full max-w-md rounded-xl border ui-border ui-panel shadow-xl">
                        <div className="border-b ui-border p-4 ui-card-gradient">
                            <h2 id="delete-slider-title" className="text-lg font-semibold ui-text">Hapus slider?</h2>
                            <p className="mt-1 text-sm ui-text-muted">Aksi ini akan menghapus slider dari homepage dan mengurutkan ulang slider lain.</p>
                        </div>
                        <div className="p-4">
                            <div className="rounded-lg border p-3 ui-warning-chip">
                                <div className="font-semibold">{deleteTarget.name}</div>
                                <div className="mt-1 break-all text-xs opacity-80">{deleteTarget._id}</div>
                            </div>
                            <div className="mt-5 flex justify-end gap-3">
                                <button
                                    type="button"
                                    onClick={() => setDeleteTarget(null)}
                                    disabled={busyId === deleteTarget._id}
                                    className="rounded-lg border px-4 py-2 text-sm font-medium ui-muted-action disabled:opacity-50"
                                >
                                    Batal
                                </button>
                                <button
                                    type="button"
                                    onClick={confirmDelete}
                                    disabled={busyId === deleteTarget._id}
                                    className="rounded-lg px-4 py-2 text-sm font-semibold ui-danger-chip disabled:opacity-50"
                                >
                                    {busyId === deleteTarget._id ? 'Menghapus...' : 'Hapus Slider'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            ) : null}

            {showModal ? (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
                    <div role="dialog" aria-modal="true" aria-labelledby="slider-modal-title" className="w-full max-w-lg rounded-xl border ui-border ui-panel shadow-xl">
                        <div className="flex items-center justify-between border-b ui-border p-4 ui-card-gradient">
                            <h2 id="slider-modal-title" className="text-lg font-semibold ui-text">
                                {editingSlider ? 'Edit Slider' : 'Tambah Slider'}
                            </h2>
                            <button onClick={() => setShowModal(false)} className="ui-text-muted hover:text-[var(--ui-text)]">
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        <form onSubmit={handleSubmit} className="space-y-4 p-4">
                            <div>
                                <label className={labelClass}>Nama Slider</label>
                                <input
                                    type="text"
                                    value={form.name}
                                    onChange={(event) => setForm({ ...form, name: event.target.value })}
                                    className={inputClass}
                                    placeholder="Promo Akhir Tahun"
                                    required
                                />
                            </div>

                            <div>
                                <label className={labelClass}>Gambar</label>
                                <ImagePickerField
                                    value={form.image}
                                    onChange={(url: string) => setForm({ ...form, image: url })}
                                    folder="covers"
                                />
                            </div>

                            <div>
                                <label className={labelClass}>Link (opsional)</label>
                                <input
                                    type="text"
                                    value={form.link}
                                    onChange={(event) => setForm({ ...form, link: event.target.value })}
                                    className={inputClass}
                                    placeholder="https://example.com/promo atau /promo"
                                />
                                {form.link.trim() ? (
                                    formLinkMeta.invalid ? (
                                        <div className="mt-2 rounded-lg border p-3 text-sm ui-danger-chip">
                                            Link tidak valid. Gunakan URL `http/https` atau path internal yang diawali `/`.
                                        </div>
                                    ) : (
                                        <div className="mt-2 rounded-lg border p-3 text-sm ui-success-chip">
                                            <div className="inline-flex items-center gap-2 font-semibold">
                                                <Link2 className="w-4 h-4" />
                                                Tujuan {formLinkMeta.label}
                                            </div>
                                            <div className="mt-1 opacity-80">{formLinkMeta.caption}</div>
                                        </div>
                                    )
                                ) : null}
                            </div>

                            <div className="flex items-center gap-2 rounded-lg border ui-border ui-panel-muted p-3">
                                <input
                                    type="checkbox"
                                    id="status"
                                    checked={form.status}
                                    onChange={(event) => setForm({ ...form, status: event.target.checked })}
                                    className="w-4 h-4 rounded border-[var(--ui-border)] bg-[var(--ui-card-bg)] text-[var(--ui-accent)] focus:ring-[var(--ui-accent)]"
                                />
                                <label htmlFor="status" className="text-sm ui-text">Aktifkan slider ini di homepage</label>
                            </div>

                            <div className="flex justify-end gap-3 pt-2">
                                <button
                                    type="button"
                                    onClick={() => setShowModal(false)}
                                    className="rounded-lg border px-4 py-2 text-sm font-medium ui-muted-action"
                                >
                                    Batal
                                </button>
                                <button
                                    type="submit"
                                    disabled={saving}
                                    className="rounded-lg ui-accent-solid px-4 py-2 text-sm font-medium disabled:opacity-50"
                                >
                                    {saving ? 'Menyimpan...' : 'Simpan'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            ) : null}
        </div>
    );
}
