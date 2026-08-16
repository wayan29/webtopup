import type { ReactNode } from 'react';

export interface SliderPoint {
    x: number;
    y: number;
}

export interface SliderData {
    _id: string;
    name: string;
    image: string;
    link?: string | null;
}

export interface DefaultSlider {
    id: string;
    title: string;
    subtitle: string;
    bg: string;
    icon?: ReactNode;
}

export interface HomeSliderCarouselProps {
    sliders: SliderData[];
    defaultSlides: DefaultSlider[];
    categoryCount?: number;
}

export interface AutoRotateOptions {
    reducedMotion: boolean;
    userPaused: boolean;
    hovered: boolean;
    focusWithin: boolean;
    count: number;
}

/** Return an index in the range [0, count), or zero when there are no slides. */
export const normalizeSlideIndex = (index: number, count: number): number => {
    if (!Number.isFinite(index) || !Number.isFinite(count) || count <= 0) {
        return 0;
    }

    const normalizedCount = Math.floor(count);
    if (normalizedCount <= 0) {
        return 0;
    }

    const normalizedIndex = Math.trunc(index) % normalizedCount;
    return normalizedIndex < 0 ? normalizedIndex + normalizedCount : normalizedIndex;
};

const hasMalformedPercentEscape = (value: string) => /%(?![0-9a-f]{2})/i.test(value);
const hasControlCharacter = (value: string) => /[\u0000-\u001f\u007f]/.test(value);

const decodeForSafety = (value: string): string | null => {
    let decoded = value;

    // Decode repeatedly so double-encoded separators/dot segments cannot bypass
    // the same validation applied to their literal equivalents.
    for (let pass = 0; pass < 3; pass += 1) {
        try {
            const next = decodeURIComponent(decoded);
            if (next === decoded) {
                break;
            }
            decoded = next;
        } catch {
            return null;
        }
    }

    return decoded;
};

const containsDotTraversal = (value: string): boolean => {
    const path = value.split(/[?#]/, 1)[0] || '';
    const decodedPath = decodeForSafety(path);
    return [path, decodedPath]
        .filter((candidate): candidate is string => candidate !== null)
        .some((candidate) => candidate.split(/[\\/]/).some((segment) => segment === '.' || segment === '..'));
};

const isUnsafePublicValue = (value: string): boolean => {
    if (hasMalformedPercentEscape(value) || hasControlCharacter(value) || value.includes('\\')) {
        return true;
    }

    const decoded = decodeForSafety(value);
    if (decoded === null || hasControlCharacter(decoded) || decoded.includes('\\')) {
        return true;
    }

    return containsDotTraversal(value) || containsDotTraversal(decoded);
};

/**
 * Classify a public slider destination without permitting unsafe schemes or
 * path syntax. Internal paths are returned byte-for-byte (apart from trim),
 * including their query and fragment.
 */
export const classifyPublicSliderLink = (raw: unknown): { href: string | null; external: boolean } => {
    if (typeof raw !== 'string') {
        return { href: null, external: false };
    }

    if (hasControlCharacter(raw)) {
        return { href: null, external: false };
    }

    const normalized = raw.trim();
    if (!normalized || isUnsafePublicValue(normalized)) {
        return { href: null, external: false };
    }

    if (normalized.startsWith('/')) {
        const decoded = decodeForSafety(normalized);
        if (normalized.startsWith('//') || decoded?.startsWith('//')) {
            return { href: null, external: false };
        }
        return { href: normalized, external: false };
    }

    try {
        const parsed = new URL(normalized);
        if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) {
            return { href: null, external: false };
        }

        // URL parsing can normalize dot segments, so inspect the raw input as
        // well as the parsed path before accepting an HTTPS destination.
        if (isUnsafePublicValue(parsed.pathname)) {
            return { href: null, external: false };
        }

        return { href: parsed.toString(), external: true };
    } catch {
        return { href: null, external: false };
    }
};

export const shouldAutoRotate = ({
    reducedMotion,
    userPaused,
    hovered,
    focusWithin,
    count,
}: AutoRotateOptions): boolean => (
    count > 1 && !reducedMotion && !userPaused && !hovered && !focusWithin
);

/**
 * Classify a pointer movement. A horizontal movement must clear the threshold
 * and remain at least as strong as the vertical movement.
 */
export const swipeDirection = (
    start: SliderPoint,
    end: SliderPoint,
    threshold: number,
): -1 | 0 | 1 => {
    const horizontal = end.x - start.x;
    const vertical = end.y - start.y;
    const minimum = Math.max(0, threshold);

    if (!Number.isFinite(horizontal) || !Number.isFinite(vertical) || Math.abs(horizontal) < minimum) {
        return 0;
    }
    if (Math.abs(vertical) >= Math.abs(horizontal)) {
        return 0;
    }

    return horizontal > 0 ? 1 : -1;
};
