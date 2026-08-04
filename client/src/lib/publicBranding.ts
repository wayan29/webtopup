export const DEFAULT_PUBLIC_BRANDING = Object.freeze({
    brand: 'Danayasa',
    title: 'Danayasa - Top Up Game Termurah',
    footerText: '© 2026 Danayasa. All Rights Reserved.',
    favicon: '/danayasa-favicon.svg',
    logo: '/danayasa-logo.svg',
    description: 'Topup Game Terlengkap & Termurah'
});

export interface PublicBrandingMetadata {
    title: string;
    favicon: string;
    description: string;
    origin?: string;
}

const CONTROL_OR_BACKSLASH = /[\u0000-\u001f\u007f\\]/;
const ENCODED_LEADING_SEPARATOR = /^\/(?:%(?:2f|5c))/i;

export function safeBrandAssetUrl(value: unknown, fallback: string, origin: string): string {
    if (typeof value !== 'string') return fallback;

    const normalized = value.trim();
    if (!normalized || CONTROL_OR_BACKSLASH.test(value)) return fallback;

    if (normalized.startsWith('/')) {
        if (normalized.startsWith('//') || ENCODED_LEADING_SEPARATOR.test(normalized)) return fallback;

        try {
            const base = new URL(origin);
            const parsed = new URL(normalized, base);
            return parsed.origin === base.origin ? normalized : fallback;
        } catch {
            return fallback;
        }
    }

    try {
        const parsed = new URL(normalized);
        return parsed.protocol === 'https:' && !parsed.username && !parsed.password
            ? parsed.toString()
            : fallback;
    } catch {
        return fallback;
    }
}

export function applyPublicBrandingMetadata(
    settings: PublicBrandingMetadata,
    targetDocument: Document
): void {
    const title = typeof settings.title === 'string' && settings.title.trim()
        ? settings.title.trim()
        : DEFAULT_PUBLIC_BRANDING.title;
    const descriptionText = typeof settings.description === 'string' && settings.description.trim()
        ? settings.description.trim()
        : DEFAULT_PUBLIC_BRANDING.description;
    const origin = settings.origin ?? targetDocument.location?.origin ?? 'https://localhost';
    const faviconUrl = safeBrandAssetUrl(settings.favicon, DEFAULT_PUBLIC_BRANDING.favicon, origin);

    targetDocument.title = title;

    const icons = Array.from(targetDocument.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'));
    const favicon = icons.shift() ?? targetDocument.createElement('link');
    favicon.rel = 'icon';
    favicon.type = 'image/svg+xml';
    favicon.href = faviconUrl;
    if (!favicon.parentNode) targetDocument.head.appendChild(favicon);
    icons.forEach((icon) => icon.remove());

    const descriptions = Array.from(targetDocument.querySelectorAll<HTMLMetaElement>('meta[name="description"]'));
    const description = descriptions.shift() ?? targetDocument.createElement('meta');
    description.name = 'description';
    description.content = descriptionText;
    if (!description.parentNode) targetDocument.head.appendChild(description);
    descriptions.forEach((meta) => meta.remove());
}
