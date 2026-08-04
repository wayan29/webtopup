import { useState, useEffect } from 'react';
import { X, Upload, Loader2, Trash2, Check, Image as ImageIcon, FolderOpen } from 'lucide-react';
import { apiV2 } from '../../api';
import { getAssetUrl } from '../../lib/assetUrl';

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
    type?: 'icons' | 'covers' | 'popups' | 'instructions';
    title?: string;
}

export default function ImagePicker({ 
    isOpen, 
    onClose, 
    onSelect, 
    currentValue,
    type = 'icons',
    title = 'Pilih Gambar'
}: ImagePickerProps) {
    const [files, setFiles] = useState<UploadedFile[]>([]);
    const [loading, setLoading] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [deleting, setDeleting] = useState<string | null>(null);
    const [selectedUrl, setSelectedUrl] = useState<string | null>(currentValue || null);
    const [activeTab, setActiveTab] = useState<'icons' | 'covers' | 'popups' | 'instructions'>(type);

    useEffect(() => {
        setActiveTab(type);
    }, [type]);

    useEffect(() => {
        if (isOpen) {
            fetchFiles();
            setSelectedUrl(currentValue || null);
        }
    }, [isOpen, activeTab]);

    const fetchFiles = async () => {
        setLoading(true);
        try {
            const res = await apiV2
                .get(`/upload/list?type=${activeTab}`);
            if (res.data.success) {
                setFiles(res.data.files);
            }
        } catch (error) {
            console.error('Failed to fetch files:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setUploading(true);
        try {
            const formData = new FormData();
            formData.append('file', file);

            const res = await apiV2
                .post(`/upload?type=${activeTab}`, formData, {
                    headers: { 'Content-Type': 'multipart/form-data' }
                });

            if (res.data.success) {
                fetchFiles();
                setSelectedUrl(res.data.url);
            }
        } catch (error) {
            console.error('Upload failed:', error);
        } finally {
            setUploading(false);
        }
    };

    const handleDelete = async (filename: string) => {
        if (!confirm('Hapus gambar ini?')) return;
        
        setDeleting(filename);
        try {
            await apiV2
                .delete(`/upload?type=${activeTab}&filename=${filename}`);
            fetchFiles();
            if (files.find(f => f.filename === filename)?.url === selectedUrl) {
                setSelectedUrl(null);
            }
        } catch (error) {
            console.error('Delete failed:', error);
        } finally {
            setDeleting(null);
        }
    };

    const handleConfirm = () => {
        if (selectedUrl) {
            onSelect(selectedUrl);
            onClose();
        }
    };

    const formatFileSize = (bytes: number) => {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    };

    if (!isOpen) return null;

    const tabs = [
        { id: type, label: title }
    ];

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm">
            <div className="ui-panel rounded-xl w-full max-w-4xl max-h-[85vh] overflow-hidden shadow-2xl border ui-border flex flex-col">
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b ui-border ui-card-gradient">
                    <div className="flex items-center gap-3">
                        <FolderOpen className="w-5 h-5 ui-accent-text" />
                        <h3 className="text-lg font-semibold ui-text">{title}</h3>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-2 ui-text-muted hover:text-[var(--ui-text)] hover:bg-[var(--ui-card-muted)] rounded-lg transition-colors"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {/* Tabs */}
                <div className="flex border-b ui-border ui-panel-muted">
                    {tabs.map(tab => (
                        <button
                            key={tab.id}
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
                        <label className={`inline-flex items-center gap-2 px-4 py-2 ui-accent-solid text-sm font-medium rounded-lg cursor-pointer transition-all ${uploading ? 'opacity-50 cursor-wait' : ''}`}>
                            {uploading ? (
                                <>
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                    Uploading...
                                </>
                            ) : (
                                <>
                                    <Upload className="w-4 h-4" />
                                    Upload Baru
                                </>
                            )}
                            <input 
                                type="file" 
                                accept="image/*" 
                                className="hidden" 
                                onChange={handleUpload}
                                disabled={uploading}
                            />
                        </label>
                    </div>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-4">
                    {loading ? (
                        <div className="flex items-center justify-center h-64">
                            <Loader2 className="w-8 h-8 ui-accent-text animate-spin" />
                        </div>
                    ) : files.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-64 ui-text-muted">
                            <ImageIcon className="w-16 h-16 mb-4 opacity-30" />
                            <p className="text-sm">Belum ada gambar di folder ini</p>
                            <p className="text-xs mt-1">Upload gambar baru untuk memulai</p>
                        </div>
                    ) : (
                        <div className="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8 gap-3">
                            {files.map((file) => (
                                <div
                                    key={file.filename}
                                    className={`relative group aspect-square rounded-lg overflow-hidden border-2 transition-all cursor-pointer ${
                                        selectedUrl === file.url 
                                             ? 'border-[var(--ui-accent)] ring-2 ring-[var(--ui-accent-soft)]' 
                                             : 'ui-border hover:border-[var(--ui-accent)]'
                                    }`}
                                    onClick={() => setSelectedUrl(file.url)}
                                >
                                    <img
                                        src={getAssetUrl(file.url)}
                                        alt={file.filename}
                                        className="w-full h-full object-cover"
                                    />
                                    
                                    {/* Selection indicator */}
                                    {selectedUrl === file.url && (
                                        <div className="absolute top-1 right-1 w-5 h-5 ui-accent-solid rounded-full flex items-center justify-center">
                                            <Check className="w-3 h-3" />
                                        </div>
                                    )}

                                    {/* Hover overlay */}
                                    <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                handleDelete(file.filename);
                                            }}
                                            disabled={deleting === file.filename}
                                            className="p-2 rounded-lg border ui-danger-action transition-colors"
                                        >
                                            {deleting === file.filename ? (
                                                <Loader2 className="w-4 h-4 animate-spin" />
                                            ) : (
                                                <Trash2 className="w-4 h-4" />
                                            )}
                                        </button>
                                    </div>

                                    {/* File info tooltip */}
                                    <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                        <p className="text-[10px] text-[var(--ui-on-accent)] truncate">{formatFileSize(file.size)}</p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between px-6 py-4 border-t ui-border ui-panel-muted">
                    <div className="text-sm ui-text-muted">
                        {selectedUrl ? (
                            <span className="flex items-center gap-2">
                                <Check className="w-4 h-4 ui-success-text" />
                                1 gambar dipilih
                            </span>
                        ) : (
                            <span>{files.length} gambar tersedia</span>
                        )}
                    </div>
                    <div className="flex gap-3">
                        <button
                            onClick={onClose}
                            className="px-4 py-2 ui-text-muted hover:text-[var(--ui-text)] hover:bg-[var(--ui-card-muted)] rounded-lg transition-colors text-sm font-medium"
                        >
                            Batal
                        </button>
                        <button
                            onClick={handleConfirm}
                            disabled={!selectedUrl}
                            className="px-5 py-2 ui-accent-solid rounded-lg text-sm font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            Pilih Gambar
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
