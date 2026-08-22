# Member Open API Settings UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the member `/settings` Open API tab readable on mobile and desktop, keep secret-once semantics, and stop leaking live credentials into docs examples without changing Open API backend contracts.

**Architecture:** Extract tab, masking, secret-status, base URL, endpoint catalog, and placeholder CURL helpers into a pure `openApiSettings` module. `Settings.tsx` consumes those helpers for URL tabs, wrapping credential cards, inline confirm, clipboard errors, and a always-visible docs summary with a closed-by-default CURL/endpoint expander.

**Tech Stack:** React 19, TypeScript 5.9, React Router `useSearchParams`, Tailwind utility classes, Lucide icons, Node test runner with `tsx`.

**Spec:** `docs/superpowers/specs/2026-08-23-member-openapi-settings-ux-design.md`

## Global Constraints

- Work inline on `/home/danayasa/proyek/webtopup` `main` with one sequential writer; do not create a worktree unless the user changes that instruction.
- Use strict RED/GREEN TDD: every behavior task starts with a focused failing test, then minimal implementation, focused pass, `git diff --check`, and a checkpoint commit.
- This is client-only. Do not change Rust routes, Node gateway routes, Mongo data, Open API request/response envelopes, or admin Users force-revoke.
- Preserve `GET /api/v2/api/key`, `POST /api/v2/api/key/generate`, and `DELETE /api/v2/api/key/revoke`. GET still never returns secret plaintext; generate still returns it once.
- Do not interpolate live `memberId`, `apiKey`, or secret into CURL examples.
- Do not add or install dependencies.
- Do not add a Playwright spec in this plan.
- User-visible Open API chrome is Indonesian; keep HTTP methods, paths, and signature field names unchanged.
- Production build/deploy/restart and GitHub push require later explicit approval.
- `docs/superpowers/` is gitignored; force-add spec/plan files with `git add -f` when committing those docs.

## File Structure

- Create `client/src/lib/openApiSettings.ts`: tab parse, key mask, secret status, base URL, endpoint catalog, placeholder CURL.
- Create `client/src/lib/openApiSettings.test.ts`: helper contracts.
- Modify `client/src/pages/Settings.tsx`: URL tabs, wrapping credentials, inline confirm, clipboard errors, docs summary + expander.
- Create `tools/dev-verification/unit/memberOpenApiSettings.test.ts`: Settings.tsx source contracts.
- Modify `package.json` script `test:dev-verify:unit`: include `client/src/lib/openApiSettings.test.ts`.

## Stable Helper Names

Use these exact exports from `client/src/lib/openApiSettings.ts`:

- `SettingsTabId = 'preferences' | 'api' | 'security'`
- `SETTINGS_TABS: SettingsTabId[]`
- `parseSettingsTab(value: unknown): SettingsTabId`
- `OpenApiSecretStatus = 'visible' | 'stored-hidden' | 'missing'`
- `openApiSecretStatus(input: { plaintext: string | null; hasStoredSecret: boolean }): OpenApiSecretStatus`
- `canCopyOpenApiSecret(status: OpenApiSecretStatus): boolean`
- `maskOpenApiKey(apiKey: string | null | undefined): string`
- `buildOpenApiBaseUrl(rawApiV2Base: string, origin: string): string`
- `OPEN_API_LIST_SIGNATURE = 'md5(member_id:api_key:secret)'`
- `OPEN_API_ORDER_SIGNATURE = 'md5(member_id:api_key:secret:ref_id)'`
- `OpenApiEndpoint = { method: 'GET' | 'POST'; path: string; description: string; extra?: string }`
- `OPEN_API_ENDPOINTS: OpenApiEndpoint[]`
- `openApiCurlExamples(baseUrl: string): string`

CURL placeholders are exactly `MEMBER_ID`, `API_KEY`, `SECRET`, `SIGNATURE`, and `REF_ID`.

---

### Task 1: Pure Open API Settings Helpers

**Files:**
- Create: `client/src/lib/openApiSettings.test.ts`
- Create: `client/src/lib/openApiSettings.ts`

**Interfaces:**
- Produces: the stable helper names listed above.
- Consumes: nothing from later tasks.

- [ ] **Step 1: Write the failing helper tests**

Create `client/src/lib/openApiSettings.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
    SETTINGS_TABS,
    parseSettingsTab,
    openApiSecretStatus,
    canCopyOpenApiSecret,
    maskOpenApiKey,
    buildOpenApiBaseUrl,
    OPEN_API_LIST_SIGNATURE,
    OPEN_API_ORDER_SIGNATURE,
    OPEN_API_ENDPOINTS,
    openApiCurlExamples,
} from './openApiSettings.ts';

test('settings tabs fail closed and keep a stable order', () => {
    assert.deepEqual(SETTINGS_TABS, ['preferences', 'api', 'security']);
    assert.equal(parseSettingsTab('api'), 'api');
    assert.equal(parseSettingsTab('security'), 'security');
    assert.equal(parseSettingsTab('preferences'), 'preferences');
    assert.equal(parseSettingsTab(null), 'preferences');
    assert.equal(parseSettingsTab('unknown'), 'preferences');
    assert.equal(parseSettingsTab(['api']), 'preferences');
});

test('secret status allows copy only while plaintext is in memory', () => {
    assert.equal(openApiSecretStatus({ plaintext: 'once-only', hasStoredSecret: true }), 'visible');
    assert.equal(openApiSecretStatus({ plaintext: null, hasStoredSecret: true }), 'stored-hidden');
    assert.equal(openApiSecretStatus({ plaintext: '', hasStoredSecret: false }), 'missing');
    assert.equal(canCopyOpenApiSecret('visible'), true);
    assert.equal(canCopyOpenApiSecret('stored-hidden'), false);
    assert.equal(canCopyOpenApiSecret('missing'), false);
});

test('api key masking keeps prefix/suffix without exposing short keys in full', () => {
    assert.equal(maskOpenApiKey(null), '');
    assert.equal(maskOpenApiKey(''), '');
    assert.equal(maskOpenApiKey('shortkey'), 'sh****ey');
    assert.equal(
        maskOpenApiKey('tv_live_abcdefghijklmnop'),
        `tv_live_${'*'.repeat(8)}ijklmnop`,
    );
});

test('open api base url joins relative and absolute v2 roots onto /api', () => {
    assert.equal(
        buildOpenApiBaseUrl('/api/v2', 'https://danayasa.biz.id'),
        'https://danayasa.biz.id/api/v2/api',
    );
    assert.equal(
        buildOpenApiBaseUrl('https://api.example.test/api/v2/', 'https://ignored.example'),
        'https://api.example.test/api/v2/api',
    );
});

test('docs catalog and curl examples stay placeholder-only', () => {
    assert.equal(OPEN_API_LIST_SIGNATURE, 'md5(member_id:api_key:secret)');
    assert.equal(OPEN_API_ORDER_SIGNATURE, 'md5(member_id:api_key:secret:ref_id)');
    assert.deepEqual(
        OPEN_API_ENDPOINTS.map((item) => `${item.method} ${item.path}`),
        [
            'GET /profile',
            'GET /categories',
            'GET /operators?category=category_id',
            'GET /product-types?category=category_id&operator=operator_id',
            'GET /products?category=category_id&operator=operator_id&type=type_id',
            'POST /order',
            'POST /transaction',
            'GET /transaction/check?ref_id=xxx&member_id=xxx&api_key=xxx&signature=xxx',
            'GET /transactions',
        ],
    );
    const examples = openApiCurlExamples('https://danayasa.biz.id/api/v2/api');
    assert.match(examples, /MEMBER_ID/);
    assert.match(examples, /API_KEY/);
    assert.match(examples, /SECRET/);
    assert.match(examples, /SIGNATURE/);
    assert.match(examples, /REF_ID/);
    assert.doesNotMatch(examples, /tv_live_/);
    assert.doesNotMatch(examples, /MBR/);
    assert.match(examples, /https:\/\/danayasa\.biz\.id\/api\/v2\/api\/products/);
    assert.match(examples, /https:\/\/danayasa\.biz\.id\/api\/v2\/api\/order/);
});
```

- [ ] **Step 2: Run the helper tests to verify RED**

Run:

```bash
node --import tsx --test client/src/lib/openApiSettings.test.ts
```

Expected: FAIL because `client/src/lib/openApiSettings.ts` does not exist.

- [ ] **Step 3: Implement the helpers**

Create `client/src/lib/openApiSettings.ts`:

```ts
export type SettingsTabId = 'preferences' | 'api' | 'security';

export const SETTINGS_TABS: SettingsTabId[] = ['preferences', 'api', 'security'];

export function parseSettingsTab(value: unknown): SettingsTabId {
    return value === 'api' || value === 'security' || value === 'preferences' ? value : 'preferences';
}

export type OpenApiSecretStatus = 'visible' | 'stored-hidden' | 'missing';

export function openApiSecretStatus(input: {
    plaintext: string | null;
    hasStoredSecret: boolean;
}): OpenApiSecretStatus {
    if (input.plaintext) return 'visible';
    if (input.hasStoredSecret) return 'stored-hidden';
    return 'missing';
}

export function canCopyOpenApiSecret(status: OpenApiSecretStatus): boolean {
    return status === 'visible';
}

export function maskOpenApiKey(apiKey: string | null | undefined): string {
    if (!apiKey) return '';
    if (apiKey.length <= 16) {
        const visible = Math.min(2, Math.floor(apiKey.length / 2));
        return `${apiKey.slice(0, visible)}${'*'.repeat(Math.max(0, apiKey.length - visible * 2))}${apiKey.slice(apiKey.length - visible)}`;
    }
    return `${apiKey.slice(0, 8)}${'*'.repeat(apiKey.length - 16)}${apiKey.slice(-8)}`;
}

export function buildOpenApiBaseUrl(rawApiV2Base: string, origin: string): string {
    const trimmed = rawApiV2Base.replace(/\/$/, '') || '/api/v2';
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        return `${trimmed}/api`;
    }
    const path = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    return `${origin.replace(/\/$/, '')}${path}/api`;
}

export const OPEN_API_LIST_SIGNATURE = 'md5(member_id:api_key:secret)';
export const OPEN_API_ORDER_SIGNATURE = 'md5(member_id:api_key:secret:ref_id)';

export type OpenApiEndpoint = {
    method: 'GET' | 'POST';
    path: string;
    description: string;
    extra?: string;
};

export const OPEN_API_ENDPOINTS: OpenApiEndpoint[] = [
    { method: 'GET', path: '/profile', description: 'Cek profil, level harga, dan saldo aktif Anda saat ini.' },
    { method: 'GET', path: '/categories', description: 'Daftar semua kategori produk aktif di platform.' },
    { method: 'GET', path: '/operators?category=category_id', description: 'Daftar brand/operator aktif, bisa difilter berdasarkan ID Kategori.' },
    { method: 'GET', path: '/product-types?category=category_id&operator=operator_id', description: 'Daftar tipe produk aktif berdasarkan Kategori dan Brand.' },
    { method: 'GET', path: '/products?category=category_id&operator=operator_id&type=type_id', description: 'Daftar katalog produk lengkap beserta harga khusus sesuai level member Anda.' },
    { method: 'POST', path: '/order', description: 'Membuat transaksi pembelian baru (parameter Tokovoucher).', extra: 'Body: { member_id, api_key, signature, ref_id, produk, tujuan, server_id? }' },
    { method: 'POST', path: '/transaction', description: 'Membuat transaksi pembelian baru (alias endpoint lama).', extra: 'Body: { member_id, api_key, signature, ref_id, product_code, target, server_id? }' },
    { method: 'GET', path: '/transaction/check?ref_id=xxx&member_id=xxx&api_key=xxx&signature=xxx', description: 'Cek detail dan status pengiriman transaksi secara real-time.' },
    { method: 'GET', path: '/transactions', description: 'Riwayat ringkasan transaksi API akun Anda.' },
];

export function openApiCurlExamples(baseUrl: string): string {
    const root = baseUrl.replace(/\/$/, '');
    return [
        '# 1. Mengambil katalog produk',
        '# signature = md5(MEMBER_ID:API_KEY:SECRET)',
        `curl -X GET "${root}/products?member_id=MEMBER_ID&api_key=API_KEY&signature=SIGNATURE"`,
        '',
        '# 2. Membuat transaksi baru',
        '# signature = md5(MEMBER_ID:API_KEY:SECRET:REF_ID)',
        `curl -X POST "${root}/order" \\`,
        '  -H "Content-Type: application/json" \\',
        "  -d '{\"member_id\":\"MEMBER_ID\",\"api_key\":\"API_KEY\",\"signature\":\"SIGNATURE\",\"ref_id\":\"REF_ID\",\"produk\":\"ML86\",\"tujuan\":\"123456789\",\"server_id\":\"1234\"}'",
    ].join('\n');
}
```

- [ ] **Step 4: Run the helper tests to verify GREEN**

Run:

```bash
node --import tsx --test client/src/lib/openApiSettings.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/openApiSettings.ts client/src/lib/openApiSettings.test.ts
git diff --check
git commit -m "feat(settings): add open api presentation helpers"
```

---

### Task 2: Persist Settings Tabs in the URL

**Files:**
- Modify: `client/src/pages/Settings.tsx`
- Create: `tools/dev-verification/unit/memberOpenApiSettings.test.ts` with tab/URL assertions only. Tasks 3–5 append more assertions to this same file.
- Test: `client/src/lib/openApiSettings.test.ts` already covers `parseSettingsTab`; do not duplicate that helper test here.

**Interfaces:**
- Consumes: `parseSettingsTab`, `SETTINGS_TABS`, `SettingsTabId` from `openApiSettings.ts`.
- Produces: `/settings?tab=api` keeps the Open API panel selected. Preferences uses no `tab` query param (`setSearchParams({}, { replace: true })`).

- [ ] **Step 1: Write the failing tab source contract**

Create `tools/dev-verification/unit/memberOpenApiSettings.test.ts`:

```ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../../..');
const settings = () => readFileSync(resolve(root, 'client/src/pages/Settings.tsx'), 'utf8');

test('member settings persist the open api tab in the url', () => {
    const source = settings();
    assert.match(source, /useSearchParams/);
    assert.match(source, /parseSettingsTab/);
    assert.match(source, /setSearchParams/);
    assert.match(source, /role="tablist"/);
    assert.match(source, /role="tab"/);
    assert.match(source, /role="tabpanel"/);
    assert.match(source, />API</);
    assert.match(source, /Tampilan & Preferensi/);
    assert.doesNotMatch(source, /max-w-xl/);
});
```

- [ ] **Step 2: Run the source contract to verify RED**

Run:

```bash
node --import tsx --test tools/dev-verification/unit/memberOpenApiSettings.test.ts
```

Expected: FAIL because `Settings.tsx` still uses `useState<TabId>` and a `max-w-xl` pill bar.

- [ ] **Step 3: Wire URL tabs and compact mobile labels**

In `client/src/pages/Settings.tsx`:

1. Add imports:

```ts
import { useSearchParams } from 'react-router-dom';
import { parseSettingsTab, type SettingsTabId } from '../lib/openApiSettings';
```

2. Remove local `type TabId = 'preferences' | 'api' | 'security'`.
3. Replace `const [activeTab, setActiveTab] = useState<TabId>('preferences');` with:

```ts
const [searchParams, setSearchParams] = useSearchParams();
const activeTab: SettingsTabId = parseSettingsTab(searchParams.get('tab'));
const setActiveTab = (next: SettingsTabId) => {
    setSearchParams(next === 'preferences' ? {} : { tab: next }, { replace: true });
};
```

4. Replace the tab bar that currently includes `max-w-xl` with:

```tsx
<div className="flex w-full min-w-0 gap-1 rounded-xl border ui-border bg-black/10 p-1" role="tablist" aria-label="Pengaturan akun">
    <button
        type="button"
        role="tab"
        aria-selected={activeTab === 'preferences'}
        onClick={() => setActiveTab('preferences')}
        className={`min-w-0 flex-1 flex items-center justify-center gap-1 sm:gap-2 px-2 sm:px-4 py-2.5 rounded-lg text-xs sm:text-sm font-semibold transition-all ${
            activeTab === 'preferences'
                ? 'ui-accent-chip shadow-sm'
                : 'ui-text-muted hover:ui-text hover:bg-white/5'
        }`}
    >
        <Sun className="h-4 w-4 shrink-0" />
        <span className="hidden sm:inline">Tampilan &amp; Preferensi</span>
        <span className="sm:hidden">Preferensi</span>
    </button>
    <button
        type="button"
        role="tab"
        aria-selected={activeTab === 'api'}
        onClick={() => setActiveTab('api')}
        className={`min-w-0 flex-1 flex items-center justify-center gap-1 sm:gap-2 px-2 sm:px-4 py-2.5 rounded-lg text-xs sm:text-sm font-semibold transition-all ${
            activeTab === 'api'
                ? 'ui-accent-chip shadow-sm'
                : 'ui-text-muted hover:ui-text hover:bg-white/5'
        }`}
    >
        <Code className="h-4 w-4 shrink-0" />
        <span className="hidden sm:inline">Open API</span>
        <span className="sm:hidden">API</span>
    </button>
    <button
        type="button"
        role="tab"
        aria-selected={activeTab === 'security'}
        onClick={() => setActiveTab('security')}
        className={`min-w-0 flex-1 flex items-center justify-center gap-1 sm:gap-2 px-2 sm:px-4 py-2.5 rounded-lg text-xs sm:text-sm font-semibold transition-all ${
            activeTab === 'security'
                ? 'ui-accent-chip shadow-sm'
                : 'ui-text-muted hover:ui-text hover:bg-white/5'
        }`}
    >
        <Shield className="h-4 w-4 shrink-0" />
        Keamanan
    </button>
</div>
```

5. Wrap each existing tab body without changing its inner JSX. The three current wrappers are `activeTab === 'preferences'`, `activeTab === 'api'`, and `activeTab === 'security'` each around `<div className="space-y-6 animate-slide-up">`. Add `role="tabpanel"` to those three wrapping divs. Do not extract or rewrite the inner preference/API/security content in this task.

Do not change generate/revoke handlers in this task.

- [ ] **Step 4: Re-run the tab source contract**

Run:

```bash
node --import tsx --test tools/dev-verification/unit/memberOpenApiSettings.test.ts client/src/lib/openApiSettings.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/Settings.tsx tools/dev-verification/unit/memberOpenApiSettings.test.ts
git diff --check
git commit -m "feat(settings): persist open api tab in the url"
```

---

### Task 3: Wrap Credentials, Confirm Inline, and Fail Clipboard Closed

**Files:**
- Modify: `client/src/pages/Settings.tsx`
- Modify: `tools/dev-verification/unit/memberOpenApiSettings.test.ts`

**Interfaces:**
- Consumes: `maskOpenApiKey`, `openApiSecretStatus`, `canCopyOpenApiSecret`.
- Produces: wrapping credential cards, disabled secret copy unless `visible`, inline confirm, clipboard error banner.

- [ ] **Step 1: Extend the source contract for credentials and confirm**

Append to `tools/dev-verification/unit/memberOpenApiSettings.test.ts`:

```ts
test('open api credentials wrap, confirm inline, and copy secret only when visible', () => {
    const source = settings();
    assert.match(source, /maskOpenApiKey/);
    assert.match(source, /openApiSecretStatus/);
    assert.match(source, /canCopyOpenApiSecret/);
    assert.match(source, /break-all/);
    assert.match(source, /grid-cols-1/);
    assert.match(source, /Buat ulang kredensial/);
    assert.match(source, /Cabut key/);
    assert.match(source, /Buat API Key & Secret/);
    assert.match(source, /pendingApiAction/);
    assert.match(source, /Gagal menyalin ke clipboard/);
    assert.doesNotMatch(source, /window\.confirm/);
    assert.doesNotMatch(source, /whitespace-nowrap/);
    assert.doesNotMatch(source, /Regenerate API Credentials/);
    assert.doesNotMatch(source, /Revoke \/ Hapus Key/);
});
```

- [ ] **Step 2: Run the new source contract to verify RED**

Run:

```bash
node --import tsx --test tools/dev-verification/unit/memberOpenApiSettings.test.ts
```

Expected: FAIL because `window.confirm`, English action labels, and `whitespace-nowrap` credential values remain.

- [ ] **Step 3: Implement credential layout, inline confirm, and clipboard errors**

In `client/src/pages/Settings.tsx`:

1. Import `maskOpenApiKey`, `openApiSecretStatus`, `canCopyOpenApiSecret`.
2. Add state:

```ts
const [pendingApiAction, setPendingApiAction] = useState<null | 'regenerate' | 'revoke'>(null);
```

3. Delete the local `maskedApiKey` expression that slices `apiKey` with `slice(0, 8)` / `slice(-8)`. Use `maskOpenApiKey(apiKey)` at the CredentialCard value instead, and compute:

```ts
const secretStatus = openApiSecretStatus({ plaintext: apiSecret, hasStoredSecret });
const secretDisplay = secretStatus === 'visible'
    ? apiSecret
    : secretStatus === 'stored-hidden'
        ? 'Tersimpan (hanya ditampilkan saat generate)'
        : '-';
```

4. Change `copyValue` to async:

```ts
const copyValue = async (value: string | null | undefined, key: string) => {
    if (!value) return;
    try {
        await navigator.clipboard.writeText(value);
        setCopied(key);
        setTimeout(() => setCopied(null), 2000);
    } catch {
        setMessage({ type: 'error', text: 'Gagal menyalin ke clipboard.' });
    }
};
```

5. Remove `window.confirm` from `generateApiKey` and `revokeApiKey`. Instead:

```ts
const requestGenerateApiKey = () => {
    if (apiKey) {
        setPendingApiAction('regenerate');
        return;
    }
    void generateApiKey();
};

const requestRevokeApiKey = () => setPendingApiAction('revoke');

const confirmPendingApiAction = async () => {
    const action = pendingApiAction;
    setPendingApiAction(null);
    if (action === 'regenerate') await generateApiKey();
    if (action === 'revoke') await revokeApiKey();
};
```

Keep the existing `generateApiKey` / `revokeApiKey` network bodies.

6. Credential grid: `grid gap-4 grid-cols-1 lg:grid-cols-3`.
7. Secret `CredentialCard` `onCopy` becomes:

```ts
onCopy={() => {
    if (!canCopyOpenApiSecret(secretStatus)) return;
    void copyValue(apiSecret, 'secret');
}}
```

Pass `copyDisabled={!canCopyOpenApiSecret(secretStatus)}` into `CredentialCard`.

8. Replace English buttons with `Buat ulang kredensial`, `Cabut key`, and `Buat API Key & Secret`. Make regenerate `w-full sm:flex-1` and revoke `w-full sm:w-auto`.
9. Render an inline confirm when `pendingApiAction` is set:

```tsx
{pendingApiAction && (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm" data-testid="settings-openapi-confirm">
        <p className="font-semibold">
            {pendingApiAction === 'regenerate'
                ? 'API key lama akan diganti. Secret baru hanya ditampilkan sekali. Lanjutkan?'
                : 'API key dan secret akan dihapus dan tidak bisa digunakan lagi. Lanjutkan?'}
        </p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <button type="button" className="ui-accent-solid rounded-xl px-4 py-2 text-sm font-bold" onClick={() => void confirmPendingApiAction()}>
                Ya, lanjutkan
            </button>
            <button type="button" className="ui-muted-action rounded-xl px-4 py-2 text-sm font-bold" onClick={() => setPendingApiAction(null)}>
                Batal
            </button>
        </div>
    </div>
)}
```

10. Update `CredentialCard` value element to `break-all whitespace-pre-wrap` (no `whitespace-nowrap`, no `overflow-x-auto`). Disable the copy button when `copyDisabled` is true (`disabled:opacity-40`).

Header copy in this panel: `Kredensial Open API` / `Gunakan kredensial ini untuk otomasi transaksi lewat API.`

- [ ] **Step 4: Re-run source and helper tests**

Run:

```bash
node --import tsx --test tools/dev-verification/unit/memberOpenApiSettings.test.ts client/src/lib/openApiSettings.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/Settings.tsx tools/dev-verification/unit/memberOpenApiSettings.test.ts
git diff --check
git commit -m "fix(settings): wrap open api credentials and confirm inline"
```

---

### Task 4: Always-Visible Docs Summary and Placeholder CURL

**Files:**
- Modify: `client/src/pages/Settings.tsx`
- Modify: `tools/dev-verification/unit/memberOpenApiSettings.test.ts`

**Interfaces:**
- Consumes: `buildOpenApiBaseUrl`, `OPEN_API_LIST_SIGNATURE`, `OPEN_API_ORDER_SIGNATURE`, `OPEN_API_ENDPOINTS`, `openApiCurlExamples`.
- Produces: docs summary always visible on the API tab; CURL/endpoints collapsed by default; no live credential interpolation; no `#0c0c16`.

- [ ] **Step 1: Extend the source contract for docs**

Append to `tools/dev-verification/unit/memberOpenApiSettings.test.ts`:

```ts
test('open api docs stay summarized until expanded and never embed live secrets', () => {
    const source = settings();
    assert.match(source, /buildOpenApiBaseUrl/);
    assert.match(source, /OPEN_API_LIST_SIGNATURE/);
    assert.match(source, /OPEN_API_ORDER_SIGNATURE/);
    assert.match(source, /OPEN_API_ENDPOINTS/);
    assert.match(source, /openApiCurlExamples/);
    assert.match(source, /Buka contoh CURL & endpoint/);
    assert.match(source, /Tutup contoh CURL & endpoint/);
    assert.match(source, /data-testid="settings-openapi-docs-summary"/);
    assert.match(source, /data-testid="settings-openapi-docs-examples"/);
    assert.doesNotMatch(source, /#0c0c16/);
    assert.doesNotMatch(source, /md5\(\$\{memberId/);
    assert.doesNotMatch(source, /showDocs && !apiLoading/);
});
```

- [ ] **Step 2: Run the docs source contract to verify RED**

Run:

```bash
node --import tsx --test tools/dev-verification/unit/memberOpenApiSettings.test.ts
```

Expected: FAIL because docs still hide behind `showDocs && !apiLoading` and CURL still interpolates `${memberId}` / `${apiKey}`.

- [ ] **Step 3: Render summary always and examples on toggle**

In `client/src/pages/Settings.tsx`:

1. Import `buildOpenApiBaseUrl`, `OPEN_API_LIST_SIGNATURE`, `OPEN_API_ORDER_SIGNATURE`, `OPEN_API_ENDPOINTS`, `openApiCurlExamples`.
2. Replace the `useMemo` base URL with:

```ts
const openApiBaseUrl = useMemo(
    () => buildOpenApiBaseUrl(rawApiV2Base, window.location.origin),
    [rawApiV2Base],
);
```

3. Remove the header-level `Buka Dokumentasi` button.
4. After the credentials/empty/warning block (still inside the API tab, including the empty-key state), always render:

```tsx
<div className="ui-panel rounded-2xl border ui-border p-4 sm:p-6 space-y-4" data-testid="settings-openapi-docs-summary">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
            <h3 className="text-base font-bold ui-text">Dokumentasi Open API</h3>
            <p className="text-xs ui-text-muted">Base URL dan formula signature. Contoh CURL tetap tertutup sampai dibuka.</p>
        </div>
        <button type="button" className="ui-muted-action inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold" onClick={() => setShowDocs((current) => !current)}>
            {showDocs ? 'Tutup contoh CURL & endpoint' : 'Buka contoh CURL & endpoint'}
        </button>
    </div>
    <div>
        <p className="text-xs font-bold uppercase tracking-wider ui-text-muted">Base URL API</p>
        <div className="mt-1 flex min-w-0 items-start gap-2 rounded-lg border ui-border bg-black/10 px-3 py-2">
            <code className="min-w-0 flex-1 break-all font-mono text-xs ui-accent-text">{openApiBaseUrl}</code>
            <button type="button" onClick={() => void copyValue(openApiBaseUrl, 'baseUrl')} className="shrink-0 p-1 ui-text-muted hover:ui-text" title="Salin Base URL">
                {copied === 'baseUrl' ? <Check className="h-4 w-4 text-green-400" /> : <Copy className="h-4 w-4" />}
            </button>
        </div>
    </div>
    <div className="space-y-2 rounded-xl border ui-border bg-black/10 p-3 font-mono text-[11px]">
        <p>Katalog &amp; profil: <code className="ui-accent-text">{OPEN_API_LIST_SIGNATURE}</code></p>
        <p>Order / cek status: <code className="ui-accent-text">{OPEN_API_ORDER_SIGNATURE}</code></p>
    </div>
</div>
```

5. When `showDocs` is true, render:

```tsx
{showDocs && (
    <div className="ui-panel rounded-2xl border ui-border p-4 sm:p-6 space-y-4" data-testid="settings-openapi-docs-examples">
        <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-xl border ui-border ui-panel-muted p-4 font-mono text-[11px] leading-relaxed ui-text">
            {openApiCurlExamples(openApiBaseUrl)}
        </pre>
        <div className="grid gap-4 sm:grid-cols-2">
            {OPEN_API_ENDPOINTS.map((endpoint) => (
                <Endpoint key={`${endpoint.method}-${endpoint.path}`} {...endpoint} />
            ))}
        </div>
    </div>
)}
```

6. In `Endpoint`, change the path `<code>` from `truncate max-w-full` to `break-all`.
7. Delete `listSignatureFormula` / `orderSignatureFormula` locals.

- [ ] **Step 4: Re-run source and helper tests**

Run:

```bash
node --import tsx --test tools/dev-verification/unit/memberOpenApiSettings.test.ts client/src/lib/openApiSettings.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/Settings.tsx tools/dev-verification/unit/memberOpenApiSettings.test.ts
git diff --check
git commit -m "fix(settings): keep open api docs summarized and placeholder-only"
```

---

### Task 5: Register Unit Coverage and Verify the Client Build

**Files:**
- Modify: `package.json` (`test:dev-verify:unit`)
- Modify: `tools/dev-verification/unit/memberOpenApiSettings.test.ts` only if a retained operational control is missing; otherwise leave it.
- Verify: `client/src/pages/Settings.tsx` still calls `apiV2.get('/api/key')`, `apiV2.post('/api/key/generate')`, and `apiV2.delete('/api/key/revoke')`.

**Interfaces:**
- Consumes: helpers and Settings wiring from Tasks 1–4.
- Produces: `npm run test:dev-verify:unit` includes `openApiSettings` tests; `npm --prefix client run build` succeeds.

- [ ] **Step 1: Write the failing unit-script and retained-API assertions**

Append to `tools/dev-verification/unit/memberOpenApiSettings.test.ts`:

```ts
test('settings keep the existing key generate and revoke endpoints', () => {
    const source = settings();
    assert.match(source, /apiV2\.get\('\/api\/key'\)/);
    assert.match(source, /apiV2\.post\('\/api\/key\/generate'\)/);
    assert.match(source, /apiV2\.delete\('\/api\/key\/revoke'\)/);
    assert.match(source, /hasSecret/);
});

test('dev-verify unit script includes open api settings helpers', () => {
    const pkg = readFileSync(resolve(root, 'package.json'), 'utf8');
    assert.match(pkg, /client\/src\/lib\/openApiSettings\.test\.ts/);
});
```

- [ ] **Step 2: Run the new assertions to verify RED**

Run:

```bash
node --import tsx --test tools/dev-verification/unit/memberOpenApiSettings.test.ts
```

Expected: FAIL on the `package.json` assertion until the script is updated. Endpoint assertions should already pass if Tasks 3–4 did not touch those calls.

- [ ] **Step 3: Register the helper test in the unit script**

In root `package.json`, change `test:dev-verify:unit` from:

```text
node --import tsx --test tools/dev-verification/unit/*.test.ts client/src/lib/auditLogQuery.test.ts client/src/lib/siteConfigMutation.test.ts client/src/lib/adminNav.test.ts client/src/lib/sliderPresentation.test.ts client/src/lib/vendorHealth.test.ts client/src/lib/digiflazzSellerCenter.test.ts && node --test scripts/security/*.test.js
```

to the same command with `client/src/lib/openApiSettings.test.ts` inserted after `client/src/lib/digiflazzSellerCenter.test.ts`.

Do not add dependencies. Do not change other scripts.

- [ ] **Step 4: Run focused verification**

Run, in order:

```bash
node --import tsx --test client/src/lib/openApiSettings.test.ts
node --import tsx --test tools/dev-verification/unit/memberOpenApiSettings.test.ts
git diff --check
npm --prefix client run build
```

Expected:

- helper tests PASS
- source-contract tests PASS
- `git diff --check` empty
- client build PASS (`tsc -b && vite build`)

If `npm run test:dev-verify:unit` is convenient, run it too; it is optional because it also executes unrelated unit files. Record whichever command was actually run.

- [ ] **Step 5: Commit**

```bash
git add package.json tools/dev-verification/unit/memberOpenApiSettings.test.ts
git diff --check
git commit -m "test(settings): cover member open api settings contracts"
```

---

## Execution notes

- Do not restart production Node/Rust or rebuild `client/dist` for the live host unless the user later asks to publish this UI.
- Do not push GitHub as part of this plan.
- A local `npm --prefix client run build` publishes `client/dist` on this host; skip that extra production publish unless explicitly requested after Task 5.
