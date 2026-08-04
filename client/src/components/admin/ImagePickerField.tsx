import { useState } from 'react';
import { Image as ImageIcon, X } from 'lucide-react';
import ImagePicker from './ImagePicker';
import { getAssetUrl } from '../../lib/assetUrl';

interface ImagePickerFieldProps {
    value: string;
    onChange: (url: string) => void;
    folder?: 'icons' | 'covers' | 'popups' | 'instructions';
}

export default function ImagePickerField({ 
    value, 
    onChange, 
    folder = 'icons'
}: ImagePickerFieldProps) {
    const [isOpen, setIsOpen] = useState(false);

    const getImageUrl = (url: string) => {
        if (!url) return '';
        if (url.startsWith('http')) return url;
        return getAssetUrl(url);
    };

    return (
        <>
            <div className="flex items-center gap-2">
                {value ? (
                    <div className="relative">
                        <img 
                            src={getImageUrl(value)} 
                            alt="Selected" 
                            className="h-16 w-16 object-cover rounded-lg border ui-border"
                        />
                        <button
                            type="button"
                            onClick={() => onChange('')}
                            className="absolute -top-2 -right-2 p-1 rounded-full border ui-danger-action"
                        >
                            <X className="w-3 h-3" />
                        </button>
                    </div>
                ) : (
                    <div className="h-16 w-16 ui-panel border ui-border rounded-lg flex items-center justify-center">
                        <ImageIcon className="w-6 h-6 ui-text-muted" />
                    </div>
                )}
                <button
                    type="button"
                    onClick={() => setIsOpen(true)}
                    className="px-4 py-2 border ui-muted-action text-sm rounded-lg transition-colors"
                >
                    {value ? 'Ganti' : 'Pilih'} Gambar
                </button>
            </div>

            <ImagePicker
                isOpen={isOpen}
                onClose={() => setIsOpen(false)}
                onSelect={(url) => {
                    onChange(url);
                    setIsOpen(false);
                }}
                currentValue={value}
                type={folder}
            />
        </>
    );
}
