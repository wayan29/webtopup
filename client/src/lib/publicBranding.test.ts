import assert from 'node:assert/strict';
import test from 'node:test';
import {
    DEFAULT_PUBLIC_BRANDING,
    applyPublicBrandingMetadata,
    safeBrandAssetUrl
} from './publicBranding.ts';

const ORIGIN = 'https://danayasa.example';

class FakeElement {
    readonly attributes = new Map<string, string>();
    parentNode: FakeHead | null = null;

    constructor(readonly tagName: string) {}

    get rel() { return this.attributes.get('rel') ?? ''; }
    set rel(value: string) { this.attributes.set('rel', value); }
    get href() { return this.attributes.get('href') ?? ''; }
    set href(value: string) { this.attributes.set('href', value); }
    get type() { return this.attributes.get('type') ?? ''; }
    set type(value: string) { this.attributes.set('type', value); }
    get name() { return this.attributes.get('name') ?? ''; }
    set name(value: string) { this.attributes.set('name', value); }
    get content() { return this.attributes.get('content') ?? ''; }
    set content(value: string) { this.attributes.set('content', value); }

    remove() {
        this.parentNode?.removeChild(this);
    }
}

class FakeHead {
    readonly children: FakeElement[] = [];

    appendChild(element: FakeElement) {
        element.parentNode = this;
        this.children.push(element);
        return element;
    }

    removeChild(element: FakeElement) {
        const index = this.children.indexOf(element);
        if (index >= 0) this.children.splice(index, 1);
        element.parentNode = null;
    }
}

class FakeDocument {
    title = '';
    readonly head = new FakeHead();

    createElement(tagName: string) {
        return new FakeElement(tagName);
    }

    querySelectorAll(selector: string) {
        if (selector === 'link[rel~="icon"]') {
            return this.head.children.filter((element) => element.tagName === 'link' && element.rel.split(/\s+/).includes('icon'));
        }
        if (selector === 'meta[name="description"]') {
            return this.head.children.filter((element) => element.tagName === 'meta' && element.name === 'description');
        }
        return [];
    }
}

test('publishes exact Danayasa defaults', () => {
    assert.equal(DEFAULT_PUBLIC_BRANDING.brand, 'Danayasa');
    assert.equal(DEFAULT_PUBLIC_BRANDING.title, 'Danayasa - Top Up Game Termurah');
    assert.equal(DEFAULT_PUBLIC_BRANDING.footerText, '© 2026 Danayasa. All Rights Reserved.');
    assert.equal(DEFAULT_PUBLIC_BRANDING.favicon, '/danayasa-favicon.svg');
    assert.equal(DEFAULT_PUBLIC_BRANDING.logo, '/danayasa-logo.svg');
    assert.equal(DEFAULT_PUBLIC_BRANDING.description, 'Topup Game Terlengkap & Termurah');
});

test('allows same-origin paths and HTTPS brand assets', () => {
    assert.equal(safeBrandAssetUrl('/assets/brand.svg', '/fallback.svg', ORIGIN), '/assets/brand.svg');
    assert.equal(
        safeBrandAssetUrl('https://cdn.example/brand.svg', '/fallback.svg', ORIGIN),
        'https://cdn.example/brand.svg'
    );
    assert.equal(
        safeBrandAssetUrl('https://danayasa.example/assets/brand.svg', '/fallback.svg', ORIGIN),
        'https://danayasa.example/assets/brand.svg'
    );
});

test('rejects unsafe, malformed, and cross-origin relative brand assets', () => {
    const rejected = [
        'http://cdn.example/brand.svg',
        '//cdn.example/brand.svg',
        'javascript:alert(1)',
        'data:image/svg+xml,<svg/>',
        '\\cdn.example\\brand.svg',
        '/assets/brand.svg\nmalicious',
        'https://[invalid',
        'brand.svg',
        './brand.svg',
        '../brand.svg',
        '/\\cdn.example/brand.svg',
        '/%5ccdn.example/brand.svg',
        '/%2f%2fcdn.example/brand.svg',
        'https://danayasa.example@cdn.example/brand.svg'
    ];

    for (const value of rejected) {
        assert.equal(safeBrandAssetUrl(value, '/fallback.svg', ORIGIN), '/fallback.svg', value);
    }
});

test('applies title, favicon, and description without duplicate metadata', () => {
    const document = new FakeDocument();
    const staleIcon = document.head.appendChild(document.createElement('link'));
    staleIcon.rel = 'shortcut icon';
    staleIcon.href = '/old.ico';
    const duplicateIcon = document.head.appendChild(document.createElement('link'));
    duplicateIcon.rel = 'icon';
    const staleDescription = document.head.appendChild(document.createElement('meta'));
    staleDescription.name = 'description';
    staleDescription.content = 'old';
    const duplicateDescription = document.head.appendChild(document.createElement('meta'));
    duplicateDescription.name = 'description';

    applyPublicBrandingMetadata({
        title: 'Runtime Danayasa',
        favicon: 'https://cdn.example/runtime.svg',
        description: 'Runtime description'
    }, document as unknown as Document);
    applyPublicBrandingMetadata({
        title: 'Runtime Danayasa',
        favicon: 'https://cdn.example/runtime.svg',
        description: 'Runtime description'
    }, document as unknown as Document);

    assert.equal(document.title, 'Runtime Danayasa');
    const icons = document.querySelectorAll('link[rel~="icon"]');
    assert.equal(icons.length, 1);
    assert.equal(icons[0]?.rel, 'icon');
    assert.equal(icons[0]?.type, 'image/svg+xml');
    assert.equal(icons[0]?.href, 'https://cdn.example/runtime.svg');
    const descriptions = document.querySelectorAll('meta[name="description"]');
    assert.equal(descriptions.length, 1);
    assert.equal(descriptions[0]?.content, 'Runtime description');
});

test('metadata application rejects an unsafe favicon and uses the bundled asset', () => {
    const document = new FakeDocument();

    applyPublicBrandingMetadata({
        title: '',
        favicon: 'javascript:alert(1)',
        description: '',
        origin: ORIGIN
    }, document as unknown as Document);

    assert.equal(document.title, DEFAULT_PUBLIC_BRANDING.title);
    assert.equal(document.querySelectorAll('link[rel~="icon"]')[0]?.href, DEFAULT_PUBLIC_BRANDING.favicon);
    assert.equal(
        document.querySelectorAll('meta[name="description"]')[0]?.content,
        DEFAULT_PUBLIC_BRANDING.description
    );
});
