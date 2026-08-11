import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Source contracts for the admin page chrome cleanup.
 *
 * The client has no React component test stack, so these assertions protect the
 * two risks of a broad hero removal: introductory copy coming back, and an
 * operational control (create/export/submit/filter) being deleted along with the
 * hero that happened to contain it.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const readAdminPage = (name: string) => fs.readFileSync(
    path.join(root, 'client/src/pages/admin', name),
    'utf8'
);

function assertChromeRemoved(name: string, removed: RegExp[], retained: RegExp[]) {
    const source = readAdminPage(name);
    for (const pattern of removed) {
        assert.doesNotMatch(source, pattern, `${name} retained intro chrome ${pattern}`);
    }
    for (const pattern of retained) {
        assert.match(source, pattern, `${name} lost operational element ${pattern}`);
    }
}

test('catalog pages remove intro copy without losing operational entry points', () => {
    assertChromeRemoved(
        'Products.tsx',
        [/Product inventory/i, /Kelola produk, harga, dan pemetaan/i],
        [/Update Harga Bulk/, /Tambah Produk/, /Filter Produk/, /openBulkPriceModal/, /handleAddProduct/, /setIsSortingOpen\(true\)/]
    );
    assertChromeRemoved(
        'FlashSales.tsx',
        [/Flash sale manager/i],
        [/Tambah Flash Sale/, /openAddModal/, /refreshAll/]
    );
    assertChromeRemoved(
        'ProductCategories.tsx',
        [/Catalog control/i],
        [/Tambah Kategori/, /Tips Pengurutan/, /handleOpenModal/]
    );
    assertChromeRemoved(
        'ProductOperators.tsx',
        [/Operator mapping/i],
        [/Tambah Operator/, /Tips Pengurutan/, /handleOpenForm/]
    );
    assertChromeRemoved(
        'ProductTypes.tsx',
        [/Product lines/i],
        [/Tambah Jenis Produk/, /Tips Pengurutan/]
    );
    assertChromeRemoved(
        'Rewards.tsx',
        [/Points & Rewards/i],
        [/Tambah Hadiah/, /Konfigurasi Poin/, /handleOpenModal/]
    );
    assertChromeRemoved(
        'Sliders.tsx',
        [/Slider showcase/i],
        [/Tambah Slider/, /openAddModal/, /fetchSliders/]
    );
    assertChromeRemoved(
        'AddOns.tsx',
        [/Addon center/i],
        [/fetchStatuses/]
    );
    assertChromeRemoved(
        'CatalogAudit.tsx',
        [/Catalog Audit/],
        [/Refresh Audit/, /Buka Produk/, /fetchReport/]
    );
    assertChromeRemoved(
        'Validation.tsx',
        [/Validation tools/i],
        [/getTitle\(\)/]
    );
    assertChromeRemoved(
        'Vouchers.tsx',
        [/Voucher Desk/i],
        [/Buat Voucher/, /Daftar Voucher/, /fetchVouchers/]
    );
});

test('catalog form pages keep submit and section headings after header removal', () => {
    assertChromeRemoved(
        'ProductOperatorForm.tsx',
        [/Kelola informasi operator produk utama/, /Tambah Operator Baru/],
        [/form="product-operator-form"/, /Simpan Data/, /Identitas Operator/, /Kembali ke Daftar Operator/]
    );
    assertChromeRemoved(
        'ProductTypeForm.tsx',
        [/Kelola varian dan konfigurasi produk per operator/, /Tambah Jenis Produk Baru/],
        [/form="product-type-form"/, /Simpan Data/, /Identitas Produk/, /Kembali ke Daftar Jenis Produk/]
    );
});

test('operations pages remove hero copy while retaining controls and data sections', () => {
    assertChromeRemoved(
        'Dashboard.tsx',
        [/Pusat Operasi/i, /Ringkasan transaksi, omset/i],
        [/Prioritas Operasional/, /Audit Katalog/, /TwoFactorReminderDialog/, /refreshAll/]
    );
    assertChromeRemoved(
        'AuditLogs.tsx',
        [/Jejak aktivitas admin/i, /Log Audit<\/h1>/],
        [/Export CSV/, /handleExport/]
    );
    assertChromeRemoved(
        'SalesReport.tsx',
        [/Laporan Penjualan Terpadu/i],
        [/handleExport/, /statusCards/, /activeRangeLabel/]
    );
    assertChromeRemoved(
        'VendorHealth.tsx',
        [/Vendor Health Dashboard<\/h1>/],
        [/Export CSV/, /handleExport/, /fetchHealth/]
    );
    assertChromeRemoved(
        'Notifications.tsx',
        [/Alert Operasional<\/h1>/, /Pusat Notifikasi/i],
        [/Tandai Dibaca/, /Belum Dibaca/, /markAllRead/, /fetchNotifications/]
    );
    assertChromeRemoved(
        'Deposits.tsx',
        [/Ruang Kendali Deposit<\/h1>/],
        [/CSV/, /pendingDeposits/, /handleExport/]
    );
    assertChromeRemoved(
        'Transactions.tsx',
        [/Kokpit Ledger Transaksi<\/h1>/],
        [/Transaksi Internal/, /Digiflazz Seller/, /CSV/, /priorityTransactions/, /syncUrlParams/]
    );
    assertChromeRemoved(
        'GuestTransactions.tsx',
        [/Pusat Transaksi Guest<\/h1>/],
        [/priorityTransactions/, /canProcess/]
    );
    assertChromeRemoved(
        'ManualTransactions.tsx',
        [/Kokpit Transaksi Manual<\/h1>/],
        [/priorityTransactions/, /scopeLabel/]
    );
});

test('admin sidebar keeps subtitle metadata searchable but never renders descriptions', () => {
    const layout = fs.readFileSync(path.join(root, 'client/src/layouts/AdminLayout.tsx'), 'utf8');

    assert.match(layout, /matchText\(item\.subtitle\)/, 'menu subtitles must remain searchable');
    assert.match(layout, /subtitle: item\.subtitle/, 'subtitle metadata must remain available to route headers');
    assert.doesNotMatch(layout, /\{item\.subtitle\}/, 'menu rows must not render item descriptions');
    assert.doesNotMatch(layout, /\{subItem\.subtitle\}/, 'submenu rows must not render descriptions');
});

test('refresh controls remain reachable after local hero refresh removal', () => {
    const layout = fs.readFileSync(path.join(root, 'client/src/layouts/AdminLayout.tsx'), 'utf8');
    assert.match(layout, /aria-label=\{`Segarkan \$\{currentRouteMeta\.title\}`\}/);
    assert.doesNotMatch(
        layout,
        /hidden sm:inline-flex items-center gap-2 text-sm font-medium/,
        'global refresh must not disappear on mobile'
    );

    const vendorHealth = readAdminPage('VendorHealth.tsx');
    assert.match(
        vendorHealth,
        /onClick=\{fetchHealth\}/,
        'Vendor Health must retain a reachable refresh action for its primary dataset'
    );
});

test('settings and account pages remove intro copy without losing security or CRUD', () => {
    assertChromeRemoved('DigiflazzSettings.tsx', [/Digiflazz Settings<\/h1>/], [/credentials/, /pricelist/, /webhook/i]);
    assertChromeRemoved('TokovoucherSettings.tsx', [/Tokovoucher Settings<\/h1>/], [/credentials/, /pricelist/, /webhook/i]);
    assertChromeRemoved('DigiflazzSellerSettings.tsx', [/Digiflazz Seller Settings<\/h1>/], [/IrsSellerSettings/, /fetchSettings/]);
    assertChromeRemoved('IrsSellerSettings.tsx', [/Integrasi IRS Seller Masuk<\/h1>/], [/status/, /mapping/, /endpoint/i]);
    assertChromeRemoved('PaymentMethods.tsx', [/Pusat Metode Pembayaran/i], [/Tambah Metode/, /Filter/, /stepUp\.dialog/]);
    assertChromeRemoved('PaymentCategories.tsx', [/Matriks Kategori Pembayaran/i], [/Tambah Kategori/, /Filter/]);
    assertChromeRemoved('Teams.tsx', [/Manajemen Tim<\/h1>/], [/Tambah Tim/, /Log Login/]);
    const teams = readAdminPage('Teams.tsx');
    assert.match(teams, /TeamAccessDialog/);
    assert.match(teams, /TeamAccessPreview/);
    assert.match(teams, /Lihat akses/);
    assert.match(teams, /normalizeTeamPermissions/);
    assert.match(teams, /canManageMember/);
    assert.match(teams, /isOwner/);
    assert.doesNotMatch(teams, /JSON\.stringify\(member\.permissions/);
    assertChromeRemoved('Users.tsx', [/User Management<\/h1>/], [/summary/, /filters/i]);
    assertChromeRemoved('Vendors.tsx', [/Kelola multiple vendor/i], [/Add Vendor/, /handleAddNew/]);
    assertChromeRemoved('Margins.tsx', [/Pengaturan Margin<\/h1>/], [/formatUpdatedAt/, /meta/]);
    assertChromeRemoved('SiteConfig.tsx', [/Pengaturan Situs<\/h1>/], [/activeTab/, /handleSave/]);
    assertChromeRemoved('Profile.tsx', [/Kelola identitas akun/i], [/Identitas Akun/, /Ubah Password/, /<Security \/>/, /stepUp\.dialog/]);
    assertChromeRemoved('Security.tsx', [/Autentikasi Dua Faktor<\/h1>/], [/twoFactorEnrollmentRequiredAt/, /Manajemen Sesi/, /enabled/]);
});

test('team access dialog preserves accessible interaction semantics', () => {
    const dialog = fs.readFileSync(path.join(root, 'client/src/components/admin/TeamAccessDialog.tsx'), 'utf8');
    const preview = fs.readFileSync(path.join(root, 'client/src/components/admin/TeamAccessPreview.tsx'), 'utf8');
    assert.match(dialog, /role="dialog"/);
    assert.match(dialog, /aria-modal="true"/);
    assert.match(dialog, /aria-label="Tutup detail akses"/);
    assert.match(dialog, /Escape/);
    assert.match(dialog, /focus\(\)/);
    assert.match(dialog, /isConnected/);
    assert.match(dialog, /Keamanan pribadi/);
    assert.match(preview, /Preview akses setelah disimpan/);
    assert.match(preview, /summarizeEffectiveTeamAccess/);
});
