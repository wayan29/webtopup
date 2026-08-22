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
