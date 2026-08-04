import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

test('public MainLayout mounts mobile bottom nav and pads content', () => {
    const layout = read('client/src/layouts/MainLayout.tsx');
    assert.match(layout, /PublicBottomNav/, 'MainLayout must mount the public bottom nav');
    assert.match(layout, /pb-\[calc\(4\.75rem\+env\(safe-area-inset-bottom,0px\)\)\]/, 'content must clear the fixed bar');
    assert.match(layout, /footer className="ui-panel ui-border hidden border-t sm:block"/, 'footer stays desktop-oriented');
    assert.doesNotMatch(layout, /Buka menu navigasi/, 'hamburger primary nav is no longer the mobile primary control');
});

test('public bottom nav component is mobile-only and names the four tabs', () => {
    const nav = read('client/src/components/public/PublicBottomNav.tsx');
    assert.match(nav, /sm:hidden/, 'bottom nav must not appear on desktop');
    assert.match(nav, /Navigasi utama publik/);
    assert.match(nav, /PUBLIC_BOTTOM_TABS/, 'labels come from the shared four-tab contract');
    assert.match(nav, /\{tab\.label\}/);
    assert.match(nav, /aria-current=\{isActive \? 'page' : undefined\}/);
});
