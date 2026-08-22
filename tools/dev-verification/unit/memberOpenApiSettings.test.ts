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
    assert.doesNotMatch(source, /rounded-xl max-w-xl/);
});

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
