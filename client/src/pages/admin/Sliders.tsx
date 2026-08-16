import { useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import {
    AlertTriangle,
    Archive,
    ArchiveRestore,
    ArrowDown,
    ArrowUp,
    Edit,
    ExternalLink,
    GripVertical,
    Image as ImageIcon,
    Link2,
    Plus,
    RefreshCw,
    RotateCcw,
    Search,
    X,
} from 'lucide-react';
import { apiV2, type ApiV2RequestConfig } from '../../api';
import { useStepUpOrchestration } from '../../auth/useStepUpOrchestration';
import AccessibleDialog from '../../components/admin/AccessibleDialog';
import ImagePickerField from '../../components/admin/ImagePickerField';
import { getAssetUrl } from '../../lib/assetUrl';
import {
    classifySliderConflict,
    createSliderIntent,
    createSliderRequest,
    parseSliderAdminSnapshot,
    parseSliderVersionConflict,
    rebaseSliderIntent,
    retrySameSliderIntent,
    sliderErrorMessage,
    type ParsedSliderAdminSnapshot,
    type SliderAdminItem,
    type SliderIntent,
} from '../../lib/sliderManagement';
import {
    DndContext,
    KeyboardSensor,
    PointerSensor,
    closestCenter,
    useSensor,
    useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import {
    SortableContext,
    arrayMove,
    sortableKeyboardCoordinates,
    useSortable,
    verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

type Slider = SliderAdminItem;
type SliderFormData = {
    name: string;
    image: string;
    link: string;
    status: boolean;
};
type StatusFilter = 'all' | 'active' | 'inactive';
type SliderView = 'current' | 'archive';
type DialogKind = 'form' | 'archive' | 'restore' | null;
type Message = { type: 'success' | 'error' | 'warning'; text: string };

type ConflictState = {
    intent: SliderIntent;
    currentSnapshot: ParsedSliderAdminSnapshot;
    currentRevision: number;
    base: Slider | null;
    draft: SliderFormData | null;
    server: Slider | null;
};

const SLIDER_CREATE_ENDPOINT = '/sliders/admin/create';
const SLIDER_UPDATE_ENDPOINT = '/sliders/admin/:id';
const SLIDER_ARCHIVE_ENDPOINT = '/sliders/admin/:id/archive';
const SLIDER_RESTORE_ENDPOINT = '/sliders/admin/:id/restore';
const SLIDER_REORDER_ENDPOINT = '/sliders/admin/reorder';

function expectedSliderEndpoint(intent: SliderIntent) {
    if (intent.action === 'create') return SLIDER_CREATE_ENDPOINT;
    if (intent.action === 'reorder') return SLIDER_REORDER_ENDPOINT;
    if (!intent.targetId) return null;
    const pattern = intent.action === 'update'
        ? SLIDER_UPDATE_ENDPOINT
        : intent.action === 'archive'
            ? SLIDER_ARCHIVE_ENDPOINT
            : SLIDER_RESTORE_ENDPOINT;
    return pattern.replace(':id', encodeURIComponent(intent.targetId));
}

const defaultForm: SliderFormData = {
    name: '',
    image: '',
    link: '',
    status: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getImageUrl(image: string) {
    if (!image) return '';
    if (/^https?:\/\//i.test(image)) return image;
    return getAssetUrl(image);
}

function getSafeSliderLink(link?: string | null) {
    const normalized = typeof link === 'string' ? link.trim() : '';
    if (!normalized || /[\r\n\t]/.test(normalized)) return null;
    if (normalized.startsWith('/')) {
        return normalized.startsWith('//') || normalized.startsWith('/\\') ? null : normalized;
    }
    try {
        const parsed = new URL(normalized);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
    } catch {
        return null;
    }
}

function getLinkMeta(link?: string | null) {
    const normalized = typeof link === 'string' ? link.trim() : '';
    if (!normalized) {
        return { safeLink: null, label: '-', caption: 'Tanpa link', invalid: false, external: false };
    }
    const safeLink = getSafeSliderLink(normalized);
    if (!safeLink) {
        return { safeLink: null, label: 'Link tidak valid', caption: normalized, invalid: true, external: false };
    }
    if (safeLink.startsWith('/')) {
        return { safeLink, label: 'Internal', caption: safeLink, invalid: false, external: false };
    }
    const parsed = new URL(safeLink);
    return {
        safeLink,
        label: parsed.hostname,
        caption: `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`,
        invalid: false,
        external: true,
    };
}

function sliderFormPayload(form: SliderFormData): Record<string, unknown> {
    return {
        name: form.name.trim(),
        image: form.image.trim(),
        link: form.link.trim(),
        status: form.status,
    };
}

function sliderToForm(slider: Slider): SliderFormData {
    return {
        name: slider.name,
        image: slider.image,
        link: slider.link || '',
        status: slider.status,
    };
}

function sliderChanges(form: SliderFormData, base: Slider | null) {
    const payload = sliderFormPayload(form);
    if (!base) return payload;
    const changes: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload)) {
        if (value !== base[key]) changes[key] = value;
    }
    return changes;
}

function extractMutationBody(response: unknown): Record<string, unknown> {
    const data = isRecord(response) && 'data' in response ? response.data : response;
    return isRecord(data) ? data : {};
}

function extractNestedSliderError(error: unknown) {
    // Keep nested error extraction explicit: error?.response?.data?.error is the primary envelope.
    const responseData = (error as { response?: { data?: unknown } })?.response?.data;
    const nestedError = isRecord(responseData) ? responseData.error : undefined;
    const body = isRecord(nestedError) ? nestedError : isRecord(responseData) ? responseData : null;
    return {
        code: typeof body?.code === 'string' ? body.code : undefined,
        message: typeof body?.message === 'string' ? body.message : undefined,
    };
}

function isSliderItem(value: unknown): value is Slider {
    if (!isRecord(value)) return false;
    return typeof value._id === 'string'
        && typeof value.name === 'string'
        && typeof value.image === 'string'
        && typeof value.link === 'string'
        && typeof value.sortOrder === 'number'
        && typeof value.status === 'boolean';
}

function readMutationSlider(body: Record<string, unknown>): Slider | null {
    const candidate = body.slider ?? (isRecord(body.data) ? body.data.slider : undefined);
    return isSliderItem(candidate) ? candidate : null;
}

function readMutationSliders(body: Record<string, unknown>): Slider[] | null {
    const candidate = body.sliders ?? (isRecord(body.data) ? body.data.sliders : undefined);
    if (!Array.isArray(candidate) || !candidate.every(isSliderItem)) return null;
    return candidate;
}

function nextSnapshot(
    snapshot: ParsedSliderAdminSnapshot,
    sliders: Slider[],
    revision: unknown,
): ParsedSliderAdminSnapshot {
    const nextRevision = typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0
        ? revision
        : snapshot.revision;
    return { ...snapshot, sliders: sliders.map((slider) => ({ ...slider })), revision: nextRevision };
}

function SliderImagePreview({
    image,
    name,
    onEdit,
    compact = false,
}: {
    image: string;
    name: string;
    onEdit?: (event: MouseEvent<HTMLButtonElement>) => void;
    compact?: boolean;
}) {
    const [broken, setBroken] = useState(false);
    const imageUrl = getImageUrl(image);

    useEffect(() => setBroken(false), [imageUrl]);

    return (
        <div className={`relative overflow-hidden rounded-xl border ui-border ui-panel ${compact ? 'aspect-[16/7]' : 'aspect-[16/6]'}`}>
            {image && !broken ? (
                <img
                    src={imageUrl}
                    alt={name}
                    className="h-full w-full object-cover"
                    onError={() => setBroken(true)}
                />
            ) : (
                <div className="flex h-full w-full flex-col items-center justify-center gap-1 p-3 text-center ui-text-muted">
                    <ImageIcon className="h-6 w-6" aria-hidden="true" />
                    <span className="text-xs">{broken ? `Gambar rusak: ${image || 'belum dipilih'}` : 'Belum ada gambar'}</span>
                    {broken && onEdit ? (
                        <button type="button" onClick={onEdit} className="text-xs font-semibold ui-accent-text">
                            Edit gambar
                        </button>
                    ) : null}
                </div>
            )}
        </div>
    );
}

function SliderLink({ link }: { link: string }) {
    const meta = getLinkMeta(link);
    if (meta.safeLink) {
        return (
            <a
                href={meta.safeLink}
                className="inline-flex max-w-full flex-col rounded-lg border ui-border ui-panel px-3 py-2 text-left hover:bg-[var(--ui-card-muted)]"
                target={meta.external ? '_blank' : undefined}
                rel={meta.external ? 'noopener noreferrer' : undefined}
            >
                <span className="inline-flex items-center gap-1 font-semibold ui-text">
                    {meta.label}
                    {meta.external ? <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" /> : null}
                </span>
                <span className="max-w-[220px] truncate text-xs ui-text-muted">{meta.caption}</span>
            </a>
        );
    }
    if (meta.invalid) {
        return (
            <div className="rounded-lg border px-3 py-2 text-xs ui-danger-chip">
                <div className="font-semibold">{meta.label}</div>
                <div className="mt-1 break-all opacity-80">{meta.caption}</div>
            </div>
        );
    }
    return <span className="ui-text-muted">-</span>;
}

// Revisioned routes only: create, update, archive, restore, and reorder. Hard delete and legacy reorder are closed.
function SortableSliderRow({
    slider,
    index,
    dragEnabled,
    busy,
    archived,
    mutationEnabled,
    onEdit,
    onArchive,
    onRestore,
}: {
    slider: Slider;
    index: number;
    dragEnabled: boolean;
    busy: boolean;
    archived: boolean;
    mutationEnabled: boolean;
    onEdit: (slider: Slider, trigger?: HTMLElement) => void;
    onArchive: (slider: Slider) => void;
    onRestore: (slider: Slider) => void;
}) {
    const sortable = useSortable({ id: slider._id, disabled: !dragEnabled });
    const style = {
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
        opacity: sortable.isDragging ? 0.5 : 1,
    };

    return (
        <tr ref={sortable.setNodeRef} style={style} className="align-top hover:bg-[var(--ui-card-bg)]">
            <td className="px-4 py-3 text-sm ui-text-muted">
                <button
                    {...sortable.attributes}
                    {...sortable.listeners}
                    type="button"
                    disabled={!dragEnabled}
                    aria-label={`Ubah urutan slider ${slider.name}`}
                    title={dragEnabled ? 'Drag untuk ubah urutan' : 'Reorder dinonaktifkan saat filter aktif atau sedang menyimpan'}
                    className={`rounded p-1 ${dragEnabled ? 'cursor-grab hover:bg-[var(--ui-card-muted)]' : 'cursor-not-allowed opacity-40'}`}
                >
                    <GripVertical className="h-4 w-4" aria-hidden="true" />
                </button>
            </td>
            <td className="px-4 py-3 text-sm ui-text">
                <div className="font-semibold">#{index + 1}</div>
                <div className="text-xs ui-text-muted">Urutan {slider.sortOrder + 1}</div>
            </td>
            <td className="min-w-[180px] px-4 py-3 text-sm ui-text">
                <div className="font-semibold">{slider.name}</div>
                <div className="break-all text-xs ui-text-muted">{slider._id}</div>
            </td>
            <td className="min-w-[220px] px-4 py-3 text-sm">
                <SliderImagePreview image={slider.image} name={slider.name} onEdit={(event) => onEdit(slider, event.currentTarget)} />
            </td>
            <td className="px-4 py-3 text-sm"><SliderLink link={slider.link} /></td>
            <td className="px-4 py-3 text-sm">
                <span className={`inline-flex rounded-full border px-2 py-1 text-xs font-semibold ${slider.status ? 'ui-success-chip' : 'ui-warning-chip'}`}>
                    {slider.status ? 'Aktif' : 'Draft'}
                </span>
                {archived ? <div className="mt-1 text-xs ui-text-muted">Arsip</div> : null}
            </td>
            <td className="px-4 py-3 text-sm ui-text">
                <div className="flex items-center gap-2">
                    {!archived ? (
                        <>
                            <button
                                type="button"
                                onClick={(event) => onEdit(slider, event.currentTarget)}
                                disabled={busy || !mutationEnabled}
                                aria-label={`Edit slider ${slider.name}`}
                                title="Edit slider"
                                className="rounded p-1.5 ui-info-chip disabled:opacity-50"
                            ><Edit className="h-4 w-4" aria-hidden="true" /></button>
                            <button
                                type="button"
                                onClick={() => onArchive(slider)}
                                disabled={busy || !mutationEnabled}
                                aria-label={`Arsipkan slider ${slider.name}`}
                                title="Arsipkan slider"
                                className="rounded p-1.5 ui-danger-action disabled:opacity-50"
                            ><Archive className="h-4 w-4" aria-hidden="true" /></button>
                        </>
                    ) : (
                        <button
                            type="button"
                            onClick={() => onRestore(slider)}
                            disabled={busy || !mutationEnabled}
                            aria-label={`Restore slider ${slider.name}`}
                            title="Restore slider sebagai draft"
                            className="rounded p-1.5 ui-success-chip disabled:opacity-50"
                        ><ArchiveRestore className="h-4 w-4" aria-hidden="true" /></button>
                    )}
                </div>
            </td>
        </tr>
    );
}

function SliderMobileCard({
    slider,
    index,
    total,
    archived,
    busy,
    canReorder,
    mutationEnabled,
    onEdit,
    onArchive,
    onRestore,
    onMove,
}: {
    slider: Slider;
    index: number;
    total: number;
    archived: boolean;
    busy: boolean;
    canReorder: boolean;
    mutationEnabled: boolean;
    onEdit: (slider: Slider, trigger?: HTMLElement) => void;
    onArchive: (slider: Slider) => void;
    onRestore: (slider: Slider) => void;
    onMove: (index: number, direction: -1 | 1) => void;
}) {
    return (
        <article className="rounded-2xl border ui-border ui-panel-muted p-3 shadow-sm">
            <SliderImagePreview image={slider.image} name={slider.name} compact onEdit={(event) => onEdit(slider, event.currentTarget)} />
            <div className="mt-3 flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <h3 className="truncate font-semibold ui-text">{slider.name}</h3>
                    <p className="break-all text-xs ui-text-muted">{slider._id}</p>
                </div>
                <span className={`shrink-0 rounded-full border px-2 py-1 text-xs font-semibold ${slider.status ? 'ui-success-chip' : 'ui-warning-chip'}`}>
                    {slider.status ? 'Aktif' : 'Draft'}
                </span>
            </div>
            <div className="mt-3 grid gap-2 text-sm">
                <div className="flex items-center justify-between rounded-lg border ui-border px-3 py-2">
                    <span className="ui-text-muted">Posisi</span>
                    <span className="font-semibold ui-text">{index + 1} / {total}</span>
                </div>
                <SliderLink link={slider.link} />
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
                {!archived && canReorder ? (
                    <>
                        <button type="button" onClick={() => onMove(index, -1)} disabled={busy || index === 0} aria-label={`Move Up slider ${slider.name}`} className="inline-flex items-center gap-1 rounded-lg border px-3 py-2 text-xs font-semibold ui-muted-action disabled:opacity-40">
                            <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" /> Move Up
                        </button>
                        <button type="button" onClick={() => onMove(index, 1)} disabled={busy || index === total - 1} aria-label={`Move Down slider ${slider.name}`} className="inline-flex items-center gap-1 rounded-lg border px-3 py-2 text-xs font-semibold ui-muted-action disabled:opacity-40">
                            <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" /> Move Down
                        </button>
                    </>
                ) : null}
                {!archived ? (
                    <>
                        <button type="button" onClick={(event) => onEdit(slider, event.currentTarget)} disabled={busy || !mutationEnabled} aria-label={`Edit slider ${slider.name}`} className="rounded-lg border px-3 py-2 text-xs font-semibold ui-info-chip disabled:opacity-50">Edit</button>
                        <button type="button" onClick={() => onArchive(slider)} disabled={busy || !mutationEnabled} aria-label={`Arsipkan slider ${slider.name}`} className="rounded-lg border px-3 py-2 text-xs font-semibold ui-danger-action disabled:opacity-50">Arsipkan</button>
                    </>
                ) : (
                    <button type="button" onClick={() => onRestore(slider)} disabled={busy || !mutationEnabled} aria-label={`Restore slider ${slider.name}`} className="rounded-lg border px-3 py-2 text-xs font-semibold ui-success-chip disabled:opacity-50">Restore</button>
                )}
            </div>
        </article>
    );
}

export default function Sliders() {
    const [view, setView] = useState<SliderView>('current');
    const [mainSnapshot, setMainSnapshot] = useState<ParsedSliderAdminSnapshot | null>(null);
    const [archiveSnapshot, setArchiveSnapshot] = useState<ParsedSliderAdminSnapshot | null>(null);
    const [mainLoading, setMainLoading] = useState(true);
    const [archiveLoading, setArchiveLoading] = useState(true);
    const [mainError, setMainError] = useState<string | null>(null);
    const [archiveError, setArchiveError] = useState<string | null>(null);
    const [staleWarning, setStaleWarning] = useState<string | null>(null);
    const [message, setMessage] = useState<Message | null>(null);
    const [search, setSearch] = useState('');
    const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
    const [dialogKind, setDialogKind] = useState<DialogKind>(null);
    const [dialogError, setDialogError] = useState<string | null>(null);
    const [form, setForm] = useState<SliderFormData>(defaultForm);
    const [editingSlider, setEditingSlider] = useState<Slider | null>(null);
    const [editingBase, setEditingBase] = useState<Slider | null>(null);
    const [formRevision, setFormRevision] = useState(0);
    const [archiveTarget, setArchiveTarget] = useState<Slider | null>(null);
    const [restoreTarget, setRestoreTarget] = useState<Slider | null>(null);
    const [saving, setSaving] = useState(false);
    const [sorting, setSorting] = useState(false);
    const [pendingIntent, setPendingIntent] = useState<SliderIntent | null>(null);
    const [conflict, setConflict] = useState<ConflictState | null>(null);
    const [unknownAction, setUnknownAction] = useState<SliderIntent | null>(null);
    const latestMainRequestId = useRef(0);
    const latestArchiveRequestId = useRef(0);
    const previousSliders = useRef<Slider[]>([]);
    const formDialogRef = useRef<HTMLDivElement>(null);
    const archiveDialogRef = useRef<HTMLDivElement>(null);
    const restoreDialogRef = useRef<HTMLDivElement>(null);
    const conflictDialogRef = useRef<HTMLDivElement>(null);
    const unknownDialogRef = useRef<HTMLDivElement>(null);
    const formInitialFocusRef = useRef<HTMLInputElement>(null);
    const formReturnFocusRef = useRef<HTMLElement>(null);
    const addTriggerRef = useRef<HTMLButtonElement>(null);
    const stepUp = useStepUpOrchestration();

    const sensors = useSensors(
        useSensor(PointerSensor),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
    );

    const fetchSliders = async (): Promise<boolean> => {
        const requestId = latestMainRequestId.current + 1;
        latestMainRequestId.current = requestId;
        setMainLoading(true);
        try {
            const response = await apiV2.get('/sliders/admin/all');
            if (requestId !== latestMainRequestId.current) return false;
            setMainSnapshot(parseSliderAdminSnapshot(response.data));
            setMainError(null);
            return true;
        } catch (error: unknown) {
            if (requestId !== latestMainRequestId.current) return false;
            setMainError(sliderErrorMessage(error));
            return false;
        } finally {
            if (requestId === latestMainRequestId.current) setMainLoading(false);
        }
    };

    const fetchArchivedSliders = async (): Promise<boolean> => {
        const requestId = latestArchiveRequestId.current + 1;
        latestArchiveRequestId.current = requestId;
        setArchiveLoading(true);
        try {
            const response = await apiV2.get('/sliders/admin/archived');
            if (requestId !== latestArchiveRequestId.current) return false;
            setArchiveSnapshot(parseSliderAdminSnapshot(response.data));
            setArchiveError(null);
            return true;
        } catch (error: unknown) {
            if (requestId !== latestArchiveRequestId.current) return false;
            setArchiveError(sliderErrorMessage(error));
            return false;
        } finally {
            if (requestId === latestArchiveRequestId.current) setArchiveLoading(false);
        }
    };

    useEffect(() => {
        void Promise.all([fetchSliders(), fetchArchivedSliders()]);
        const handler = () => {
            void Promise.all([fetchSliders(), fetchArchivedSliders()]);
        };
        window.addEventListener('admin:refresh-current-page', handler);
        return () => window.removeEventListener('admin:refresh-current-page', handler);
    }, []);

    useEffect(() => {
        if (stepUp.ambiguousMessage) {
            setMessage({ type: 'error', text: stepUp.ambiguousStatusMessage });
        }
    }, [stepUp.ambiguousMessage, stepUp.ambiguousStatusMessage]);

    const snapshot = view === 'current' ? mainSnapshot : archiveSnapshot;
    const loading = view === 'current' ? mainLoading : archiveLoading;
    const loadError = view === 'current' ? mainError : archiveError;
    const items = snapshot?.sliders ?? [];
    const mutationEnabled = snapshot?.mutationEnabled === true;
    const limits = snapshot?.limits;
    const canAdd = mainSnapshot?.mutationEnabled === true && (mainSnapshot.limits?.remainingTotal ?? 0) > 0;
    const keyword = search.trim().toLowerCase();
    const filteredItems = useMemo(() => items.filter((slider) => {
        const matchesSearch = !keyword
            || slider.name.toLowerCase().includes(keyword)
            || slider.link.toLowerCase().includes(keyword);
        const matchesStatus = statusFilter === 'all'
            || (statusFilter === 'active' ? slider.status : !slider.status);
        return matchesSearch && matchesStatus;
    }), [items, keyword, statusFilter]);
    const canReorder = view === 'current'
        && mutationEnabled
        && !keyword
        && statusFilter === 'all'
        && !sorting
        && !saving;

    const summary = useMemo(() => {
        const total = items.length;
        const active = items.filter((slider) => slider.status).length;
        return { total, active, inactive: total - active };
    }, [items]);

    const resetDialog = () => {
        if (saving) return;
        setDialogKind(null);
        setDialogError(null);
    };

    const openAddModal = (event?: MouseEvent<HTMLButtonElement>) => {
        if (!canAdd) return;
        formReturnFocusRef.current = event?.currentTarget ?? addTriggerRef.current;
        setEditingSlider(null);
        setEditingBase(null);
        setForm(defaultForm);
        setFormRevision(mainSnapshot?.revision ?? 0);
        setPendingIntent(null);
        setDialogError(null);
        setDialogKind('form');
    };

    const handleEdit = (slider: Slider, trigger?: HTMLElement) => {
        if (!mainSnapshot?.mutationEnabled) return;
        formReturnFocusRef.current = trigger ?? null;
        setEditingSlider(slider);
        setEditingBase({ ...slider });
        setForm(sliderToForm(slider));
        setFormRevision(mainSnapshot.revision);
        setPendingIntent(null);
        setDialogError(null);
        setDialogKind('form');
    };

    const openArchive = (slider: Slider) => {
        if (!mainSnapshot?.mutationEnabled) return;
        setArchiveTarget(slider);
        setDialogError(null);
        setDialogKind('archive');
    };

    const openRestore = (slider: Slider) => {
        if (!archiveSnapshot?.mutationEnabled) return;
        setRestoreTarget(slider);
        setDialogError(null);
        setDialogKind('restore');
    };

    const dispatchSliderIntent = async (intent: SliderIntent) => {
        const request = createSliderRequest(intent);
        if (request.url !== expectedSliderEndpoint(intent)) {
            throw new Error('Endpoint mutasi slider tidak valid');
        }
        const method = request.method.toLowerCase() as 'post' | 'put';
        return stepUp.run(
            'settings.sensitive',
            (config) => apiV2.request({
                ...config,
                method,
                url: request.url,
                data: request.body,
                headers: {
                    ...((config.headers as unknown as Record<string, unknown> | undefined) ?? {}),
                    ...request.headers,
                },
            }),
            {
                method,
                url: request.url,
                headers: request.headers,
            } as unknown as ApiV2RequestConfig,
        );
    };

    const applyMutationBody = (intent: SliderIntent, body: Record<string, unknown>) => {
        const resultSlider = readMutationSlider(body);
        const resultSliders = readMutationSliders(body);
        const revision = body.revision ?? (isRecord(body.data) ? body.data.revision : undefined);
        const targetId = intent.targetId;
        const updateCurrent = (previous: ParsedSliderAdminSnapshot | null, actionView: SliderView) => {
            if (!previous) return previous;
            let nextSliders = previous.sliders as Slider[];
            if (resultSliders && intent.action === 'reorder') {
                nextSliders = resultSliders;
            } else if (resultSlider && intent.action === 'create') {
                nextSliders = [...nextSliders, resultSlider].sort((left, right) => left.sortOrder - right.sortOrder);
            } else if (resultSlider && intent.action === 'update') {
                nextSliders = nextSliders.map((slider) => slider._id === resultSlider._id ? resultSlider : slider);
            } else if (resultSlider && intent.action === 'archive') {
                nextSliders = nextSliders.filter((slider) => slider._id !== targetId);
            } else if (resultSlider && intent.action === 'restore' && actionView === 'current') {
                nextSliders = [...nextSliders, resultSlider].sort((left, right) => left.sortOrder - right.sortOrder);
            }
            return nextSnapshot(previous, nextSliders, revision);
        };
        if (intent.action === 'archive') {
            setMainSnapshot((previous) => updateCurrent(previous, 'current'));
            setArchiveSnapshot((previous) => resultSlider && previous
                ? nextSnapshot(previous, [...previous.sliders, resultSlider], revision)
                : previous);
        } else if (intent.action === 'restore') {
            setArchiveSnapshot((previous) => previous
                ? nextSnapshot(previous, previous.sliders.filter((slider) => slider._id !== targetId), revision)
                : previous);
            setMainSnapshot((previous) => updateCurrent(previous, 'current'));
        } else if (intent.action === 'reorder') {
            setMainSnapshot((previous) => updateCurrent(previous, 'current'));
        } else {
            setMainSnapshot((previous) => updateCurrent(previous, 'current'));
        }
    };

    const refreshAfterMutation = async (action: SliderIntent['action']) => {
        const results = action === 'archive' || action === 'restore'
            ? await Promise.all([fetchSliders(), fetchArchivedSliders()])
            : [await fetchSliders()];
        return results.every(Boolean);
    };

    const openConflict = (intent: SliderIntent, versionConflict: NonNullable<ReturnType<typeof parseSliderVersionConflict>>) => {
        const server = intent.action === 'update'
            ? versionConflict.currentSnapshot.sliders.find((slider) => slider._id === intent.targetId) ?? null
            : null;
        setConflict({
            intent,
            currentSnapshot: versionConflict.currentSnapshot,
            currentRevision: versionConflict.currentRevision,
            base: editingBase,
            draft: intent.action === 'update' ? { ...form } : null,
            server,
        });
        setDialogKind(null);
        setDialogError(null);
    };

    const performMutation = async (
        intent: SliderIntent,
        successMessage: string,
        affected: SliderIntent['action'],
    ) => {
        setPendingIntent(intent);
        setSaving(true);
        setDialogError(null);
        setMessage(null);
        try {
            const response = await dispatchSliderIntent(intent);
            const body = extractMutationBody(response);
            // Apply the frozen successful response before reloading. A refresh failure must not
            // turn a proven mutation into a false failure.
            applyMutationBody(intent, body);
            setPendingIntent(null);
            setArchiveTarget(null);
            setRestoreTarget(null);
            setEditingSlider(null);
            setEditingBase(null);
            setDialogKind(null);
            setMessage({ type: 'success', text: body.replayed ? `${successMessage} (replay).` : successMessage });
            const refreshed = await refreshAfterMutation(affected);
            if (!refreshed) {
                setStaleWarning('Perubahan berhasil, tetapi sinkronisasi snapshot gagal. Muat ulang sebelum membuat tindakan baru.');
            } else {
                setStaleWarning(null);
            }
        } catch (error: unknown) {
            setPendingIntent(null);
            const nested = extractNestedSliderError(error);
            const versionConflict = parseSliderVersionConflict(error);
            if (versionConflict) {
                // SLIDER_VERSION_CONFLICT preserves the draft and offers an explicit rebase.
                openConflict(intent, versionConflict);
            } else if (nested.code === 'SLIDER_COMMIT_UNKNOWN') {
                // SLIDER_COMMIT_UNKNOWN is investigation-only; never offer a mutation retry.
                setUnknownAction(intent);
                setDialogKind(null);
                setDialogError(null);
            } else if (!((error as { code?: string })?.code === 'STEP_UP_CANCELLED')) {
                setDialogError(sliderErrorMessage(error));
            }
        } finally {
            setSaving(false);
        }
    };

    const handleSubmit = async (event: FormEvent) => {
        event.preventDefault();
        if (!mainSnapshot?.mutationEnabled) {
            setDialogError('Backend slider belum siap untuk mutasi revisioned');
            return;
        }
        const validationError = !form.name.trim()
            ? 'Nama slider wajib diisi'
            : !form.image.trim()
                ? 'Gambar slider wajib diisi'
                : form.link.trim() && !getSafeSliderLink(form.link)
                    ? 'Link slider harus berupa URL http/https atau path internal yang diawali "/"'
                    : null;
        if (validationError) {
            setDialogError(validationError);
            return;
        }
        const changes = sliderChanges(form, editingBase);
        if (Object.keys(changes).length === 0) {
            setDialogError('Tidak ada perubahan untuk disimpan.');
            return;
        }
        const expectedRevision = formRevision;
        const pendingPayload = pendingIntent?.payload;
        const intent = pendingIntent
            && pendingIntent.action === (editingSlider ? 'update' : 'create')
            && pendingIntent.expectedRevision === expectedRevision
            && JSON.stringify(pendingPayload) === JSON.stringify(changes)
            ? retrySameSliderIntent(pendingIntent)
            : createSliderIntent(editingSlider ? 'update' : 'create', editingSlider?._id ?? null, expectedRevision, changes);
        await performMutation(intent, editingSlider ? 'Slider berhasil diperbarui' : 'Slider berhasil ditambahkan', editingSlider ? 'update' : 'create');
    };

    const confirmArchive = async () => {
        if (!archiveTarget || !mainSnapshot?.mutationEnabled) return;
        const intent = createSliderIntent('archive', archiveTarget._id, mainSnapshot.revision, {});
        await performMutation(intent, `Slider "${archiveTarget.name}" berhasil diarsipkan`, 'archive');
    };

    const confirmRestore = async () => {
        if (!restoreTarget || !archiveSnapshot?.mutationEnabled) return;
        const intent = createSliderIntent('restore', restoreTarget._id, archiveSnapshot.revision, {});
        await performMutation(intent, `Slider "${restoreTarget.name}" berhasil direstore sebagai draft`, 'restore');
    };

    const saveReordered = async (reordered: Slider[]) => {
        if (!mainSnapshot?.mutationEnabled || !canReorder) return;
        const previous = (mainSnapshot.sliders as Slider[]).map((slider) => ({ ...slider }));
        previousSliders.current = previous;
        setMainSnapshot((current) => current ? nextSnapshot(current, reordered, current.revision) : current);
        setSorting(true);
        const orders = reordered.map((slider, index) => ({ id: slider._id, sortOrder: index }));
        const intent = createSliderIntent('reorder', null, mainSnapshot.revision, orders);
        try {
            setPendingIntent(intent);
            const response = await dispatchSliderIntent(intent);
            const body = extractMutationBody(response);
            applyMutationBody(intent, body);
            setPendingIntent(null);
            setMessage({ type: 'success', text: body.replayed ? 'Urutan slider berhasil dilanjutkan (replay).' : 'Urutan slider berhasil diperbarui.' });
            const refreshed = await refreshAfterMutation('reorder');
            if (!refreshed) setStaleWarning('Urutan berhasil disimpan, tetapi sinkronisasi snapshot gagal.');
            else setStaleWarning(null);
        } catch (error: unknown) {
            setPendingIntent(null);
            // Roll back the optimistic reorder immediately, before optional reconciliation fetch.
            setMainSnapshot((current) => current ? nextSnapshot(current, previousSliders.current, current.revision) : current);
            const versionConflict = parseSliderVersionConflict(error);
            const nested = extractNestedSliderError(error);
            if (versionConflict) openConflict(intent, versionConflict);
            else if (nested.code === 'SLIDER_COMMIT_UNKNOWN') {
                setUnknownAction(intent);
                setMessage({ type: 'error', text: sliderErrorMessage(error) });
            } else if ((error as { code?: string })?.code !== 'STEP_UP_CANCELLED') {
                setMessage({ type: 'error', text: sliderErrorMessage(error) });
            }
        } finally {
            setSorting(false);
        }
    };

    const handleDragEnd = (event: DragEndEvent) => {
        if (!canReorder || !event.over || event.active.id === event.over.id) return;
        const oldIndex = items.findIndex((slider) => slider._id === event.active.id);
        const newIndex = items.findIndex((slider) => slider._id === event.over?.id);
        if (oldIndex < 0 || newIndex < 0) return;
        const reordered = arrayMove(items as Slider[], oldIndex, newIndex).map((slider, index) => ({ ...slider, sortOrder: index }));
        void saveReordered(reordered);
    };

    const moveSlider = (index: number, direction: -1 | 1) => {
        if (!canReorder) return;
        const nextIndex = index + direction;
        if (nextIndex < 0 || nextIndex >= items.length) return;
        const reordered = arrayMove(items as Slider[], index, nextIndex).map((slider, order) => ({ ...slider, sortOrder: order }));
        void saveReordered(reordered);
    };

    const loadLatestSnapshot = async () => {
        const intent = conflict?.intent ?? unknownAction;
        setConflict(null);
        setUnknownAction(null);
        const results = intent?.action === 'archive' || intent?.action === 'restore'
            ? await Promise.all([fetchSliders(), fetchArchivedSliders()])
            : [await fetchSliders()];
        if (results.every(Boolean)) {
            setMessage({ type: 'success', text: 'Snapshot terbaru berhasil dimuat.' });
            setStaleWarning(null);
        }
    };

    const discardConflict = () => {
        setConflict(null);
        setPendingIntent(null);
        setDialogKind(null);
        setDialogError(null);
    };

    const applyNonconflictingChanges = () => {
        if (!conflict?.server || !conflict.draft || !conflict.base || conflict.intent.action !== 'update') return;
        const kinds = classifySliderConflict(
            conflict.base as unknown as Record<string, unknown>,
            sliderFormPayload(conflict.draft),
            conflict.server as unknown as Record<string, unknown>,
        );
        const merged: SliderFormData = { ...sliderToForm(conflict.server) };
        const mergedRecord = merged as unknown as Record<string, unknown>;
        const draftRecord = conflict.draft as unknown as Record<string, unknown>;
        for (const key of Object.keys(merged)) {
            if (kinds[key] === 'draft-only') mergedRecord[key] = draftRecord[key];
        }
        const changes = sliderChanges(merged, conflict.server);
        if (!Object.keys(changes).length) {
            setForm(sliderToForm(conflict.server));
            setEditingBase(conflict.server);
            setEditingSlider(conflict.server);
            setFormRevision(conflict.currentRevision);
            setConflict(null);
            setDialogKind('form');
            setDialogError('Tidak ada perubahan draft-only yang dapat diterapkan.');
            return;
        }
        const rebased = rebaseSliderIntent(conflict.intent, conflict.currentRevision, changes);
        setForm(merged);
        setEditingBase(conflict.server);
        setEditingSlider(conflict.server);
        setFormRevision(conflict.currentRevision);
        setPendingIntent(rebased);
        setConflict(null);
        setDialogKind('form');
        setDialogError('Perubahan non-konflik dipertahankan. Tinjau lalu simpan dengan revisi terbaru.');
    };

    const reviewConflict = conflict?.server && conflict.draft && conflict.base
        ? classifySliderConflict(
            conflict.base as unknown as Record<string, unknown>,
            sliderFormPayload(conflict.draft),
            conflict.server as unknown as Record<string, unknown>,
        )
        : null;

    const openAudit = () => {
        window.location.assign('/admin/audit-logs');
    };

    const resetFilters = () => {
        setSearch('');
        setStatusFilter('all');
    };

    return (
        <div className="space-y-5" aria-busy={loading || saving || sorting ? 'true' : 'false'}>
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="inline-flex rounded-xl border ui-border ui-panel-muted p-1" role="tablist" aria-label="Tampilan slider">
                    <button type="button" role="tab" aria-selected={view === 'current'} onClick={() => setView('current')} className={`rounded-lg px-4 py-2 text-sm font-semibold ${view === 'current' ? 'ui-accent-solid' : 'ui-muted-action'}`}>{'Aktif & Draft'}</button>
                    <button type="button" role="tab" aria-selected={view === 'archive'} onClick={() => setView('archive')} className={`rounded-lg px-4 py-2 text-sm font-semibold ${view === 'archive' ? 'ui-accent-solid' : 'ui-muted-action'}`}>Arsip</button>
                </div>
                <div className="flex flex-wrap gap-2">
                    {view === 'current' ? (
                        <button ref={addTriggerRef} type="button" onClick={openAddModal} disabled={!canAdd} title={!canAdd ? 'Kapasitas total habis atau backend belum siap' : undefined} className="inline-flex items-center gap-2 rounded-xl ui-accent-solid px-4 py-2.5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50">
                            <Plus className="h-4 w-4" aria-hidden="true" /> Tambah Slider
                        </button>
                    ) : null}
                    <button type="button" onClick={() => void (view === 'current' ? fetchSliders() : fetchArchivedSliders())} className="inline-flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-semibold ui-muted-action">
                        <RefreshCw className="h-4 w-4" aria-hidden="true" /> Segarkan
                    </button>
                </div>
            </div>

            {snapshot && !mutationEnabled ? (
                <div role="alert" className="flex items-start gap-3 rounded-xl border p-4 text-sm ui-warning-chip">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <div><strong>Backend slider belum siap untuk mutasi revisioned</strong><p className="mt-1">Data lama tetap dapat dibaca, tetapi semua mutasi dinonaktifkan sampai marker `slider-revision-v1` tersedia.</p></div>
                </div>
            ) : null}

            {staleWarning ? <div role="status" className="rounded-xl border p-3 text-sm ui-warning-chip">{staleWarning}</div> : null}
            {message ? <div role={message.type === 'error' ? 'alert' : 'status'} className={`rounded-xl border p-3 text-sm ${message.type === 'success' ? 'ui-success-chip' : message.type === 'warning' ? 'ui-warning-chip' : 'ui-danger-chip'}`}>{message.text}</div> : null}
            {!snapshot && loadError ? <div role="alert" className="rounded-xl border p-4 text-sm ui-danger-chip">{loadError}</div> : null}
            {snapshot && loadError ? <div role="status" className="rounded-xl border p-3 text-sm ui-warning-chip">Snapshot terakhir dipertahankan. Sinkronisasi gagal: {loadError}</div> : null}

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                <div className="rounded-2xl border ui-border ui-panel-muted p-4"><p className="text-[11px] uppercase tracking-[0.18em] ui-text-muted">Revision</p><p className="mt-2 text-3xl font-black ui-text">{snapshot?.revision ?? '-'}</p><p className="mt-1 text-sm ui-text-muted">Snapshot baca saja</p></div>
                <div className="rounded-2xl border ui-border ui-panel-muted p-4"><p className="text-[11px] uppercase tracking-[0.18em] ui-text-muted">Current total</p><p className="mt-2 text-3xl font-black ui-text">{limits?.currentTotal ?? summary.total}</p><p className="mt-1 text-sm ui-text-muted">{summary.total} tampil di view</p></div>
                <div className="rounded-2xl border ui-border ui-panel-muted p-4"><p className="text-[11px] uppercase tracking-[0.18em] ui-text-muted">Current active</p><p className="mt-2 text-3xl font-black ui-text">{limits?.currentActive ?? summary.active}</p><p className="mt-1 text-sm ui-text-muted">{summary.inactive} draft/nonaktif</p></div>
                <div className="rounded-2xl border ui-border ui-panel-muted p-4"><p className="text-[11px] uppercase tracking-[0.18em] ui-text-muted">Sisa kapasitas total</p><p className="mt-2 text-3xl font-black ui-text">{limits?.remainingTotal ?? '-'}</p><p className="mt-1 text-sm ui-text-muted">Maksimal 20 current</p></div>
                <div className="rounded-2xl border ui-border ui-panel-muted p-4"><p className="text-[11px] uppercase tracking-[0.18em] ui-text-muted">Sisa kapasitas aktif</p><p className="mt-2 text-3xl font-black ui-text">{limits?.remainingActive ?? '-'}</p><p className="mt-1 text-sm ui-text-muted">Maksimal 8 publik</p></div>
            </div>

            <div className="rounded-xl border ui-border ui-panel-muted p-4 space-y-4">
                <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px_auto]">
                    <div className="relative">
                        <label htmlFor="slider-search" className="sr-only">Cari slider</label>
                        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 ui-text-muted" aria-hidden="true" />
                        <input id="slider-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} className="w-full rounded-lg border px-3 py-2 pl-9 text-sm ui-field" placeholder="Cari nama slider atau link..." />
                    </div>
                    <div>
                        <label htmlFor="slider-status-filter" className="sr-only">Filter status slider</label>
                        <select id="slider-status-filter" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)} className="w-full rounded-lg border px-3 py-2 text-sm ui-field">
                            <option value="all">Semua Status</option><option value="active">Aktif</option><option value="inactive">Draft / Nonaktif</option>
                        </select>
                    </div>
                    <button type="button" onClick={resetFilters} className="inline-flex items-center justify-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold ui-muted-action"><RotateCcw className="h-4 w-4" aria-hidden="true" /> Reset</button>
                </div>
                <div className="flex flex-wrap items-center gap-3 text-sm ui-text-muted">
                    <span>{filteredItems.length} slider tampil</span>
                    {!canReorder && view === 'current' ? <span className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs ui-warning-chip"><AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" /> Reorder dinonaktifkan saat filter aktif, marker belum siap, atau sedang menyimpan.</span> : <span className="rounded-full border ui-border px-3 py-1 text-xs">Drag atau tombol Move Up/Down aktif</span>}
                </div>
            </div>

            {loading ? <div role="status" className="rounded-xl border ui-border ui-panel-muted px-4 py-10 text-center ui-text-muted">Memuat snapshot slider...</div> : null}
            {!loading && snapshot && filteredItems.length === 0 ? <div className="rounded-xl border ui-border ui-panel-muted px-4 py-10 text-center ui-text-muted">{items.length === 0 ? (view === 'current' ? 'Belum ada slider aktif atau draft.' : 'Belum ada slider di arsip.') : 'Tidak ada slider yang cocok dengan filter.'}</div> : null}

            {!loading && filteredItems.length > 0 ? (
                <>
                    <div className="hidden overflow-hidden rounded-xl border ui-border ui-panel-muted md:block">
                        <div className="overflow-x-auto">
                            <table className="hidden md:table min-w-full">
                                <thead><tr className="ui-panel text-xs uppercase ui-text-muted"><th className="w-12 px-4 py-3 text-left"> </th><th className="px-4 py-3 text-left">Urutan</th><th className="px-4 py-3 text-left">Nama</th><th className="px-4 py-3 text-left">Preview</th><th className="px-4 py-3 text-left">Link</th><th className="px-4 py-3 text-left">Status</th><th className="px-4 py-3 text-left">Aksi</th></tr></thead>
                                <tbody className="divide-y ui-border">
                                    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                                        <SortableContext items={filteredItems.map((slider) => slider._id)} strategy={verticalListSortingStrategy}>
                                            {filteredItems.map((slider, index) => <SortableSliderRow key={slider._id} slider={slider} index={index} dragEnabled={canReorder} busy={saving || sorting} archived={view === 'archive'} mutationEnabled={mutationEnabled} onEdit={handleEdit} onArchive={openArchive} onRestore={openRestore} />)}
                                        </SortableContext>
                                    </DndContext>
                                </tbody>
                            </table>
                        </div>
                    </div>
                    <div className="space-y-3 md:hidden">
                        {filteredItems.map((slider, index) => <SliderMobileCard key={slider._id} slider={slider} index={index} total={filteredItems.length} archived={view === 'archive'} busy={saving || sorting} canReorder={canReorder} mutationEnabled={mutationEnabled} onEdit={handleEdit} onArchive={openArchive} onRestore={openRestore} onMove={(_position, direction) => moveSlider(items.findIndex((item) => item._id === slider._id), direction)} />)}
                    </div>
                </>
            ) : null}

            <AccessibleDialog open={dialogKind === 'form'} titleId="slider-form-title" descriptionId="slider-form-description" dialogRef={formDialogRef} initialFocusRef={formInitialFocusRef} returnFocusRef={formReturnFocusRef} busy={saving} onClose={resetDialog}>
                <div className="border-b ui-border p-4 ui-card-gradient"><div className="flex items-center justify-between gap-3"><div><h2 id="slider-form-title" className="text-lg font-semibold ui-text">{editingSlider ? 'Edit Slider' : 'Tambah Slider'}</h2><p id="slider-form-description" className="mt-1 text-sm ui-text-muted">Perubahan disimpan sebagai intent revisioned pada snapshot {formRevision}.</p></div><button type="button" onClick={resetDialog} disabled={saving} aria-label="Tutup form slider" className="rounded-lg p-2 ui-muted-action disabled:opacity-50"><X className="h-5 w-5" aria-hidden="true" /></button></div></div>
                <form onSubmit={handleSubmit} className="space-y-4 overflow-y-auto p-4">
                    {dialogError ? <div role="alert" className="rounded-lg border p-3 text-sm ui-danger-chip">{dialogError}</div> : null}
                    <div><label htmlFor="slider-name" className="mb-1 block text-sm font-medium ui-text">Nama Slider</label><input ref={formInitialFocusRef} id="slider-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} aria-invalid={!form.name.trim() ? 'true' : undefined} className="w-full rounded-lg border px-3 py-2 text-sm ui-field" required /></div>
                    <div><label className="mb-1 block text-sm font-medium ui-text">Gambar cover</label><ImagePickerField value={form.image} onChange={(url: string) => setForm({ ...form, image: url })} folder="covers" restrictSelectionTo="covers" parentDialogRef={formDialogRef} /><div className="mt-3 grid gap-3 sm:grid-cols-2"><SliderImagePreview image={form.image} name={form.name || 'Slider desktop'} onEdit={() => undefined} /><div className="rounded-xl border ui-border ui-panel-muted p-3 text-xs ui-text-muted"><strong className="ui-text">Preview mobile</strong><p className="mt-1">Crop aman untuk layar mobile akan mengikuti area tengah.</p><div className="mt-2"><SliderImagePreview image={form.image} name={form.name || 'Slider mobile'} compact onEdit={() => undefined} /></div></div></div><p className="mt-2 text-xs ui-text-muted">Gunakan cover terdaftar; rekomendasi 1600×600 desktop dan area aman di tengah untuk mobile.</p></div>
                    <div><label htmlFor="slider-link" className="mb-1 block text-sm font-medium ui-text">Link (opsional)</label><input id="slider-link" value={form.link} onChange={(event) => setForm({ ...form, link: event.target.value })} aria-describedby="slider-link-help" className="w-full rounded-lg border px-3 py-2 text-sm ui-field" placeholder="https://example.com/promo atau /promo" /><p id="slider-link-help" className="mt-1 text-xs ui-text-muted">Kosong, path internal, atau URL HTTPS/HTTP yang aman.</p>{form.link.trim() && getSafeSliderLink(form.link) ? <div className="mt-2 rounded-lg border p-3 text-sm ui-success-chip"><Link2 className="mr-1 inline h-4 w-4" aria-hidden="true" /> Tujuan {getLinkMeta(form.link).label}</div> : null}</div>
                    <div className="rounded-lg border ui-border ui-panel-muted p-3 text-sm" aria-live="polite"><p className="font-semibold ui-text">Dampak publik</p><p className="mt-1 ui-text-muted">{form.status ? (editingSlider?.status ? 'Perubahan akan memodifikasi konten slider yang sedang publik.' : 'Slider akan menjadi publik setelah disimpan.') : editingSlider?.status ? 'Slider akan dinonaktifkan dari tampilan publik.' : 'Slider tetap menjadi draft nonaktif.'}</p><p className="mt-1 text-xs ui-text-muted">Rust tetap authoritative untuk menentukan sensitivitas dan meminta step-up bila diperlukan.</p></div>
                    <label className="flex items-center gap-2 rounded-lg border ui-border ui-panel-muted p-3 text-sm ui-text"><input type="checkbox" checked={form.status} onChange={(event) => setForm({ ...form, status: event.target.checked })} className="h-4 w-4" /> Publikasikan sebagai slider aktif</label>
                    <div className="flex justify-end gap-3 pt-2"><button type="button" onClick={resetDialog} disabled={saving} className="rounded-lg border px-4 py-2 text-sm font-medium ui-muted-action disabled:opacity-50">Batal</button><button type="submit" disabled={saving || !mainSnapshot?.mutationEnabled} className="rounded-lg ui-accent-solid px-4 py-2 text-sm font-semibold disabled:opacity-50">{saving ? 'Menyimpan...' : 'Simpan Slider'}</button></div>
                </form>
            </AccessibleDialog>

            <AccessibleDialog open={dialogKind === 'archive' && archiveTarget !== null} titleId="slider-archive-title" descriptionId="slider-archive-description" dialogRef={archiveDialogRef} busy={saving} onClose={resetDialog}>
                {archiveTarget ? <><div className="border-b ui-border p-4 ui-card-gradient"><h2 id="slider-archive-title" className="text-lg font-semibold ui-text">Arsipkan slider?</h2><p id="slider-archive-description" className="mt-1 text-sm ui-text-muted">Slider akan dikeluarkan dari current/public view tanpa menghapus data permanen.</p></div><div className="space-y-4 p-4">{dialogError ? <div role="alert" className="rounded-lg border p-3 text-sm ui-danger-chip">{dialogError}</div> : null}<div className="rounded-lg border p-3 ui-warning-chip"><strong>{archiveTarget.name}</strong><p className="mt-1 text-xs">Asset tetap tercatat dan dapat dipulihkan dari Arsip.</p></div><div className="flex justify-end gap-3"><button type="button" onClick={resetDialog} disabled={saving} className="rounded-lg border px-4 py-2 text-sm ui-muted-action">Batal</button><button type="button" onClick={() => void confirmArchive()} disabled={saving || !mainSnapshot?.mutationEnabled} className="rounded-lg ui-danger-chip px-4 py-2 text-sm font-semibold">{saving ? 'Mengarsipkan...' : 'Arsipkan Slider'}</button></div></div></> : null}
            </AccessibleDialog>

            <AccessibleDialog open={dialogKind === 'restore' && restoreTarget !== null} titleId="slider-restore-title" descriptionId="slider-restore-description" dialogRef={restoreDialogRef} busy={saving} onClose={resetDialog}>
                {restoreTarget ? <><div className="border-b ui-border p-4 ui-card-gradient"><h2 id="slider-restore-title" className="text-lg font-semibold ui-text">Restore slider?</h2><p id="slider-restore-description" className="mt-1 text-sm ui-text-muted">Restore selalu membuat slider kembali sebagai draft nonaktif. Publikasi dilakukan lewat edit terpisah.</p></div><div className="space-y-4 p-4">{dialogError ? <div role="alert" className="rounded-lg border p-3 text-sm ui-danger-chip">{dialogError}</div> : null}<div className="rounded-lg border p-3 ui-success-chip"><strong>{restoreTarget.name}</strong><p className="mt-1 text-xs">Slider akan ditambahkan kembali ke current view dengan urutan baru.</p></div><div className="flex justify-end gap-3"><button type="button" onClick={resetDialog} disabled={saving} className="rounded-lg border px-4 py-2 text-sm ui-muted-action">Batal</button><button type="button" onClick={() => void confirmRestore()} disabled={saving || !archiveSnapshot?.mutationEnabled} className="rounded-lg ui-accent-solid px-4 py-2 text-sm font-semibold">{saving ? 'Merestore...' : 'Restore sebagai Draft'}</button></div></div></> : null}
            </AccessibleDialog>

            <AccessibleDialog open={conflict !== null} titleId="slider-conflict-title" descriptionId="slider-conflict-description" dialogRef={conflictDialogRef} busy={saving} onClose={discardConflict}>
                {conflict ? <><div className="border-b ui-border p-4 ui-card-gradient"><h2 id="slider-conflict-title" className="text-lg font-semibold ui-text">Konflik revision slider</h2><p id="slider-conflict-description" className="mt-1 text-sm ui-text-muted">Server berada pada revision {conflict.currentRevision}. Draft tidak akan ditimpa otomatis.</p></div><div className="space-y-4 overflow-y-auto p-4">{conflict.intent.action === 'update' && reviewConflict ? <div role="status" className="space-y-2 rounded-lg border ui-border p-3 text-sm"><p className="font-semibold ui-text">Review perubahan tiga arah</p>{Object.entries(reviewConflict).map(([field, kind]) => <div key={field} className="flex items-center justify-between gap-3 border-b ui-border py-1 last:border-0"><span className="ui-text">{field}</span><span className={`text-xs font-semibold ${kind === 'conflict' ? 'ui-danger-text' : kind === 'draft-only' ? 'ui-accent-text' : 'ui-text-muted'}`}>{kind}</span></div>)}</div> : <div className="rounded-lg border p-3 text-sm ui-warning-chip">Snapshot server berubah sebelum aksi {conflict.intent.action} selesai.</div>}<div role="alert" className="rounded-lg border p-3 text-sm ui-danger-chip">Daftar slider telah berubah. Pilih tindakan eksplisit sebelum melanjutkan.</div><div className="flex flex-wrap justify-end gap-2"><button type="button" onClick={() => void loadLatestSnapshot()} className="rounded-lg border px-3 py-2 text-sm font-semibold ui-muted-action">Load Latest Snapshot</button>{conflict.intent.action === 'update' ? <button type="button" onClick={applyNonconflictingChanges} className="rounded-lg ui-accent-solid px-3 py-2 text-sm font-semibold">Apply Nonconflicting Changes</button> : null}<button type="button" onClick={discardConflict} className="rounded-lg border px-3 py-2 text-sm font-semibold ui-danger-chip">Discard Draft</button></div></div></> : null}
            </AccessibleDialog>

            {stepUp.dialog}
            <AccessibleDialog open={unknownAction !== null} titleId="slider-unknown-title" descriptionId="slider-unknown-description" dialogRef={unknownDialogRef} onClose={() => setUnknownAction(null)}>
                {unknownAction ? <><div className="border-b ui-border p-4 ui-card-gradient"><h2 id="slider-unknown-title" className="text-lg font-semibold ui-text">Status belum dapat dipastikan</h2><p id="slider-unknown-description" className="mt-1 text-sm ui-text-muted">Server tidak dapat membuktikan hasil mutasi {unknownAction.action}. Jangan mengulangi mutasi dengan intent ini.</p></div><div className="space-y-4 p-4"><div role="alert" className="rounded-lg border p-3 text-sm ui-warning-chip">Periksa snapshot terbaru dan audit sebelum membuat tindakan baru. Commit-unknown memerlukan rekonsiliasi.</div><div className="flex justify-end gap-2"><button type="button" onClick={() => void loadLatestSnapshot()} className="rounded-lg border px-3 py-2 text-sm font-semibold ui-muted-action">Load Latest Snapshot</button><button type="button" onClick={openAudit} className="rounded-lg ui-accent-solid px-3 py-2 text-sm font-semibold">Open Audit</button></div></div></> : null}
            </AccessibleDialog>
        </div>
    );
}
