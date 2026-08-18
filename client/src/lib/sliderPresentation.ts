import type { SliderAdminItem, SliderLimits } from './sliderManagement';

export type SliderView = 'current' | 'archive';

export const sliderStatusLabel = (view: SliderView, status: boolean): 'Aktif' | 'Draft' | 'Diarsipkan' => (
    view === 'archive' ? 'Diarsipkan' : status ? 'Aktif' : 'Draft'
);

/**
 * Active-capacity guard for the publish control: activation needs one free
 * active slot unless the slider is already active today (editing must stay
 * possible so it can be unpublished). Backend limits remain authoritative.
 */
export const canActivateSlider = (limits: SliderLimits | undefined, wasActive: boolean) => (
    wasActive || Boolean(limits && limits.remainingActive > 0)
);

export type SliderPositionInput = {
    sortOrder: number;
    total: number;
    filtered: boolean;
    archived: boolean;
};

/**
 * Authoritative position copy: sortOrder is the global order, never the
 * filtered-list index, so filtered or archived lists cannot mislead.
 */
export const sliderPositionLabel = ({ sortOrder, total, filtered, archived }: SliderPositionInput) => {
    const position = sortOrder + 1;
    if (archived) return `Urutan terakhir ${position}`;
    if (filtered) return `Urutan asli ${position}`;
    return `Posisi ${position} dari ${total}`;
};

export const formatArchivedMeta = (slider: SliderAdminItem): string | null => {
    if (!slider.archivedAt) return null;
    const date = new Date(slider.archivedAt);
    if (Number.isNaN(date.getTime())) return null;
    const formatted = new Intl.DateTimeFormat('id-ID', {
        dateStyle: 'medium',
        timeStyle: 'short',
    }).format(date);
    return slider.archivedBy
        ? `Diarsipkan ${formatted} oleh ${slider.archivedBy}`
        : `Diarsipkan ${formatted}`;
};
