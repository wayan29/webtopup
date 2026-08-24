import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../../..');
const read = (relativePath: string) => readFileSync(resolve(root, relativePath), 'utf8');

test('guest public check still requires whatsapp while dashboard check uses the member session', () => {
    const page = read('client/src/pages/CheckTransaction.tsx');
    const rust = read('rust-api/src/routes/guest_transactions/public.rs');
    const home = read('client/src/pages/Home.tsx');

    assert.match(page, /isEmbeddedInDashboard \? undefined : phone/);
    assert.match(page, /\/dashboard\/check-transaction\?invoice=/);
    assert.match(page, /guest-transactions\/check\/\$\{/);
    assert.match(
        page,
        /fetchTransaction\(invoice, isEmbeddedInDashboard \? undefined : whatsapp\)/,
        'dashboard refresh must not pass leftover WhatsApp into fetch',
    );
    assert.match(page, /isEmbeddedInDashboard[\s\S]{0,220}Masukkan invoice untuk melihat status transaksi/);
    assert.match(page, /Masukkan invoice dan WhatsApp untuk melihat status transaksi/);
    assert.doesNotMatch(
        page,
        /isEmbeddedInDashboard[\s\S]{0,80}Nomor WhatsApp/,
        'dashboard check form must not render a WhatsApp field',
    );
    assert.match(page, /Nomor WhatsApp/);
    assert.match(page, /cek transaksi publik membutuhkan invoice dan nomor WhatsApp/);

    assert.match(rust, /guest_check_proof/);
    assert.match(rust, /resolve_optional_member_access/);
    assert.match(rust, /Nomor WhatsApp wajib diisi untuk cek transaksi/);

    assert.match(home, /No\. WhatsApp/);
    assert.match(home, /guest-transactions\/check\/\$\{trimmedInvoice\}/);
    assert.match(home, /params = \{ whatsapp: trimmedPhone \}/);
});
