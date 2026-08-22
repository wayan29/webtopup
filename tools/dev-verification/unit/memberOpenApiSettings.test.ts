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
