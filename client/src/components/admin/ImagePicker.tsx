import { useEffect, useRef, useState, type ChangeEvent, type RefObject } from 'react';
import { X, Upload, Loader2, Trash2, Check, Image as ImageIcon, FolderOpen } from 'lucide-react';
import { apiV2 } from '../../api';
import { getAssetUrl } from '../../lib/assetUrl';
import AccessibleDialog from './AccessibleDialog';

type ImageFolder = 'icons' | 'covers' | 'popups' | 'instructions';

interface UploadedFile {
    url: string;
    filename: string;
    size: number;
    uploadedAt: string;
}

interface ImagePickerProps {
    isOpen: boolean;
    onClose: () => void;
    onSelect: (url: string) => void;
    currentValue?: string;
    type?: ImageFolder;
    title?: string;
    restrictSelectionTo?: ImageFolder;
    parentDialogRef?: RefObject<HTMLElement | null>;
}

const tabs: Array<{ id: ImageFolder; label: string }> = [
    { id: 'icons', label: 'Ikon' },
    { id: 'covers', label: 'Cover / Banner' },
    { id: 'popups', label: 'Popup' },
    { id: 'instructions', label: 'Instruksi' },
];

const safeDeleteError = (error: unknown): string => {
    const responseData = (error as { response?: { data?: unknown } } | null)?.response?.data;
    if (responseData && typeof responseData === 'object') {
        const envelope = responseData as { error?: unknown; code?: unknown; message?: unknown };
        const nested = envelope.error && typeof envelope.error === 'object'
            ? envelope.error as { code?: unknown; message?: unknown }
            : undefined;
        const code = nested?.code ?? envelope.code;
        const message = typeof nested?.message === 'string' ? nested.message.trim() : '';
        if (code === 'ASSET_IN_USE') {
            return message || 'Gambar masih digunakan dan tidak dapat dihapus.';
        }
        if (message) return message;
        if (typeof envelope.message === 'string' && envelope.message.trim()) {
            return envelope.message.trim();
        }
    }
    return 'Gagal menghapus gambar. Coba lagi.';
};

const isAssetInFolder = (url: string, folder: ImageFolder) => (
    url.includes(`/uploads/${folder}/`)
);

export default function ImagePicker({
    isOpen,
    onClose,
    onSelect,
    currentValue,
    type = 'icons',
    title = 'Pilih Gambar',
    restrictSelectionTo,
    parentDialogRef,
}: ImagePickerProps) {
    const [files, setFiles] = useState<UploadedFile[]>([]);
    const [loading, setLoading] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [deleting, setDeleting] = useState<string | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<UploadedFile | null>(null);
    const [selectedUrl, setSelectedUrl] = useState<string | null>(currentValue || null);
    const [pickerError, setPickerError] = useState<string | null>(null);
    const [deleteError, setDeleteError] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState<ImageFolder>(type);
    const pickerDialogRef = useRef<HTMLDivElement | null>(null);
    const mainInitialFocusRef = useRef<HTMLButtonElement | null>(null);
    const deleteInitialFocusRef = useRef<HTMLButtonElement | null>(null);
    const returnFocusRef = useRef<HTMLElement | null>(null);

    useEffect(() => {
        setActiveTab(type);
    }, [type]);

    useEffect(() => {
        if (isOpen) {
            if (document.activeElement instanceof HTMLElement) {
                returnFocusRef.current = document.activeElement;
            }
            void fetchFiles();
            setSelectedUrl(currentValue || null);
        }
    }, [isOpen, activeTab]);

    const fetchFiles = async () => {
        setLoading(true);
        setPickerError(null);
        try {
            const res = await apiV2.get(`/upload/list?type=${activeTab}`);
            if (res.data.success) {
                setFiles(res.data.files);
            } else {
                setPickerError('Gagal memuat daftar gambar.');
            }
        } catch {
            setPickerError('Gagal memuat daftar gambar.');
        } finally {
            setLoading(false);
        }
    };

    const handleUpload = async (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;

        setUploading(true);
        setPickerError(null);
        try {
            const formData = new FormData();
            formData.append('file', file);

            const res = await apiV2.post(`/upload?type=${activeTab}`, formData, {
                headers: { 'Content-Type': 'multipart/form-data' },
            });

            if (res.data.success) {
                await fetchFiles();
                if (!restrictSelectionTo || activeTab === restrictSelectionTo) {
                    setSelectedUrl(res.data.url);
                }
            } else {
                setPickerError('Gagal mengunggah gambar.');
            }
        } catch {
            setPickerError('Gagal mengunggah. Gunakan JPEG, PNG, atau WebP · maks. 5 MiB · maks. 4096×4096');
        } finally {
            setUploading(false);
            event.target.value = '';
        }
    };

    const canSelectInActiveFolder = !restrictSelectionTo || activeTab === restrictSelectionTo;
    const canConfirm = Boolean(
        selectedUrl
        && canSelectInActiveFolder
        && (!restrictSelectionTo || isAssetInFolder(selectedUrl, restrictSelectionTo)),
    );
    const dialogBusy = uploading || deleting !== null || deleteTarget !== null;

    const handlePickerClose = () => {
        if (dialogBusy) return;
        onClose();
    };

    const handleConfirm = () => {
        if (!canConfirm || !selectedUrl) return;
        onSelect(selectedUrl);
        onClose();
    };

    const openDeleteConfirmation = (file: UploadedFile) => {
        setDeleteError(null);
        setDeleteTarget(file);
    };

    const handleDeleteConfirmed = async () => {
        if (!deleteTarget) return;

        const target = deleteTarget;
        setDeleting(target.filename);
        setDeleteError(null);
        try {
            await apiV2.delete(`/upload?type=${activeTab}&filename=${target.filename}`);
            setFiles((current) => current.filter((file) => file.filename !== target.filename));
            setSelectedUrl((current) => current === target.url ? null : current);
            setDeleteTarget(null);
            await fetchFiles();
        } catch (error) {
            setDeleteError(safeDeleteError(error));
        } finally {
            setDeleting(null);
        }
    };

    const formatFileSize = (bytes: number) => {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    };

    if (!isOpen) return null;

    return (
        <>
            <AccessibleDialog
                open={isOpen}
                titleId="image-picker-title"
                descriptionId="image-picker-description"
                initialFocusRef={mainInitialFocusRef}
                returnFocusRef={returnFocusRef}
                parentDialogRef={parentDialogRef}
                dialogRef={pickerDialogRef}
                busy={dialogBusy}
                onClose={handlePickerClose}
            >
                <div className="flex min-h-0 flex-1 flex-col">
                    <div className="px-4 pt-3">
                        <p id="image-picker-description" className="text-xs ui-text-muted">
                            JPEG, PNG, atau WebP · maks. 5 MiB · maks. 4096×4096
                        </p>
                        {pickerError ? <div role="alert" className="mt-1 text-sm text-red-600">{pickerError}</div> : null}
                    </div>

                    <div className="flex items-start justify-between gap-4 border-b ui-border px-6 py-4 ui-card-gradient">
                        <div className="flex min-w-0 items-center gap-3">
                            <FolderOpen className="h-5 w-5 shrink-0 ui-accent-text" aria-hidden="true" />
                            <h2 id="image-picker-title" className="truncate text-lg font-semibold ui-text">{title}</h2>
                        </div>
                        <button
                            ref={mainInitialFocusRef}
                            type="button"
                            onClick={handlePickerClose}
                            disabled={dialogBusy}
                            aria-label="Tutup pemilih gambar"
                            className="ui-muted-action shrink-0 rounded-lg p-2 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            <X className="h-5 w-5" aria-hidden="true" />
                        </button>
                    </div>

                    <div role="tablist" aria-label="Folder galeri" className="flex flex-wrap border-b ui-border ui-panel-muted">
                        {tabs.map((tab) => (
                            <button
                                key={tab.id}
                                type="button"
                                role="tab"
                                aria-selected={activeTab === tab.id}
                                aria-controls={`image-picker-panel-${tab.id}`}
                                onClick={() => setActiveTab(tab.id)}
                                className={`px-5 py-3 text-sm font-medium transition-colors ${
                                    activeTab === tab.id
                                        ? 'ui-accent-text border-b-2 border-[var(--ui-accent)] bg-[var(--ui-card-bg)]'
                                        : 'ui-text-muted hover:text-[var(--ui-text)]'
                                }`}
                            >
                                {tab.label}
                            </button>
                        ))}
                        <div className="ml-auto px-4 py-2">
                            <label className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-all ui-accent-solid ${uploading ? 'cursor-wait opacity-50' : 'cursor-pointer'}`}>
                                {uploading ? (
                                    <>
                                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                                        Mengunggah…
                                    </>
                                ) : (
                                    <>
                                        <Upload className="h-4 w-4" aria-hidden="true" />
                                        Upload Baru
                                    </>
                                )}
                                <input
                                    type="file"
                                    accept="image/*"
                                    className="hidden"
                                    onChange={handleUpload}
                                    disabled={uploading}
                                    aria-label="Upload gambar baru"
                                />
                            </label>
                        </div>
                    </div>

                    <div
                        id={`image-picker-panel-${activeTab}`}
                        role="tabpanel"
                        aria-label={`Gambar folder ${activeTab}`}
                        className="min-h-0 flex-1 overflow-y-auto p-4"
                    >
                        {restrictSelectionTo && activeTab !== restrictSelectionTo ? (
                            <p className="mb-3 rounded-lg border ui-border ui-panel-muted p-3 text-xs ui-text-muted">
                                Folder ini dapat dijelajahi, tetapi hanya gambar dari folder {restrictSelectionTo} yang dapat dipilih.
                            </p>
                        ) : null}
                        {loading ? (
                            <div className="flex h-64 items-center justify-center" role="status" aria-label="Memuat gambar">
                                <Loader2 className="h-8 w-8 animate-spin ui-accent-text" aria-hidden="true" />
                            </div>
                        ) : files.length === 0 ? (
                            <div className="flex h-64 flex-col items-center justify-center ui-text-muted">
                                <ImageIcon className="mb-4 h-16 w-16 opacity-30" aria-hidden="true" />
                                <p className="text-sm">Belum ada gambar di folder ini</p>
                                <p className="mt-1 text-xs">Upload gambar baru untuk memulai</p>
                            </div>
                        ) : (
                            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
                                {files.map((file) => {
                                    const selected = selectedUrl === file.url;
                                    const selectable = canSelectInActiveFolder;
                                    return (
                                        <div key={file.filename} className="group relative min-w-0">
                                            <button
                                                type="button"
                                                aria-pressed={selectedUrl === file.url}
                                                aria-label={`Pilih ${file.filename}, ${formatFileSize(file.size)}${selected ? ', dipilih' : ''}`}
                                                disabled={!selectable}
                                                onClick={() => {
                                                    if (selectable) setSelectedUrl(file.url);
                                                }}
                                                className={`relative aspect-square w-full overflow-hidden rounded-lg border-2 text-left transition-all disabled:cursor-not-allowed disabled:opacity-60 ${
                                                    selected
                                                        ? 'border-[var(--ui-accent)] ring-2 ring-[var(--ui-accent-soft)]'
                                                        : 'ui-border hover:border-[var(--ui-accent)]'
                                                }`}
                                            >
                                                <img
                                                    src={getAssetUrl(file.url)}
                                                    alt={file.filename}
                                                    className="h-full w-full object-cover"
                                                />
                                                <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent px-1.5 pb-1 pt-5 text-[10px] text-[var(--ui-on-accent)]">
                                                    <span className="block truncate">{file.filename}</span>
                                                    <span className="block">{formatFileSize(file.size)}</span>
                                                </span>
                                                {selected ? (
                                                    <span className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full ui-accent-solid" aria-hidden="true">
                                                        <Check className="h-3 w-3" />
                                                    </span>
                                                ) : null}
                                            </button>
                                            <button
                                                type="button"
                                                aria-label={`Hapus gambar ${file.filename}`}
                                                onClick={() => openDeleteConfirmation(file)}
                                                disabled={deleting !== null}
                                                className="ui-danger-action absolute right-1 top-1 rounded-lg border p-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 disabled:cursor-not-allowed disabled:opacity-50"
                                            >
                                                {deleting === file.filename ? (
                                                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                                                ) : (
                                                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                                                )}
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-3 border-t ui-border px-6 py-4 ui-panel-muted">
                        <div className="text-sm ui-text-muted">
                            {canConfirm ? (
                                <span className="flex items-center gap-2">
                                    <Check className="h-4 w-4 ui-success-text" aria-hidden="true" />
                                    1 gambar dipilih
                                </span>
                            ) : restrictSelectionTo && activeTab !== restrictSelectionTo ? (
                                <span>Pilih gambar dari folder {restrictSelectionTo} untuk melanjutkan.</span>
                            ) : (
                                <span>{files.length} gambar tersedia</span>
                            )}
                        </div>
                        <div className="flex gap-3">
                            <button
                                type="button"
                                onClick={handlePickerClose}
                                disabled={dialogBusy}
                                className="ui-muted-action rounded-lg px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                Batal
                            </button>
                            <button
                                type="button"
                                onClick={handleConfirm}
                                disabled={!canConfirm || dialogBusy}
                                aria-label="Konfirmasi pilih gambar"
                                className="ui-accent-solid rounded-lg px-5 py-2 text-sm font-medium transition-all disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                Pilih Gambar
                            </button>
                        </div>
                    </div>
                </div>
            </AccessibleDialog>

            <AccessibleDialog
                open={deleteTarget !== null}
                titleId="image-delete-title"
                descriptionId="image-delete-description"
                initialFocusRef={deleteInitialFocusRef}
                parentDialogRef={pickerDialogRef}
                busy={deleting !== null}
                onClose={() => {
                    if (deleting === null) setDeleteTarget(null);
                }}
            >
                <div className="space-y-4 p-6">
                    <div>
                        <h2 id="image-delete-title" className="text-lg font-bold ui-text">Hapus gambar?</h2>
                        <p id="image-delete-description" className="mt-1 text-sm ui-text-muted">
                            {deleteTarget ? `Gambar ${deleteTarget.filename} akan dihapus.` : 'Tindakan ini tidak dapat dibatalkan.'}
                        </p>
                    </div>
                    {deleteError ? <div role="alert" className="rounded-lg border p-3 text-sm ui-danger-chip">{deleteError}</div> : null}
                    <div className="flex justify-end gap-3">
                        <button
                            ref={deleteInitialFocusRef}
                            type="button"
                            onClick={() => setDeleteTarget(null)}
                            disabled={deleting !== null}
                            className="ui-muted-action rounded-lg px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            Batal
                        </button>
                        <button
                            type="button"
                            onClick={() => void handleDeleteConfirmed()}
                            disabled={deleting !== null || deleteTarget === null}
                            aria-label={deleteTarget ? `Konfirmasi hapus gambar ${deleteTarget.filename}` : 'Konfirmasi hapus gambar'}
                            className="ui-danger-action rounded-lg px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {deleting !== null ? 'Menghapus…' : 'Hapus gambar'}
                        </button>
                    </div>
                </div>
            </AccessibleDialog>
        </>
    );
}
