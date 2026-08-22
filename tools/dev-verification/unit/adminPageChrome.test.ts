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
        [/Ekspor CSV/, /handleExport/, /fetchHealth/]
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
    assert.match(vendorHealth, /admin:refresh-current-page/, 'Vendor Health must load both datasets from the global refresh action');
    assert.match(vendorHealth, /Promise\.all/);
    assert.match(vendorHealth, /latestHealthRequestId/);
    assert.match(vendorHealth, /latestDiagnosticsRequestId/);
    assert.match(vendorHealth, /parseVendorHealthResponse/);
    assert.match(vendorHealth, /parseVendorHealthDiagnostics/);
    assert.match(vendorHealth, /role="status"/);
    assert.match(vendorHealth, /role="alert"/);
    assert.match(vendorHealth, /aria-busy/);
    assert.match(vendorHealth, /Ekspor CSV/);
    assert.match(vendorHealth, /Tidak tersedia/);
    assert.match(vendorHealth, /vendorSuccessRateLabel\(/, 'zero-transaction copy is served by the pure module and wired here');
    assert.match(vendorHealth, /handleExport/);
    assert.match(vendorHealth, /exports\.sensitive/);
    assert.match(vendorHealth, /stepUp\.dialog/);
    assert.doesNotMatch(vendorHealth, /onClick=\{fetchHealth\}/);
    assert.doesNotMatch(
        vendorHealth,
        /Refresh Snapshot|Snapshot Read-only Vendor|Connected|Degraded|Healthy|Warning|Critical|Success Rate|Generated:/,
        'Vendor Health must speak Indonesian and keep exactly one authoritative dataset'
    );
});

test('settings and account pages remove intro copy without losing security or CRUD', () => {
    assertChromeRemoved('DigiflazzSettings.tsx', [/Digiflazz Settings<\/h1>/], [/credentials/, /pricelist/, /webhook/i]);
    assertChromeRemoved('TokovoucherSettings.tsx', [/Tokovoucher Settings<\/h1>/], [/credentials/, /pricelist/, /webhook/i]);
    assertChromeRemoved('DigiflazzSellerChannel.tsx', [/Digiflazz Seller Settings<\/h1>/], [/refreshRevision/, /fetchSettings/, /onMutationComplete/]);
    assertChromeRemoved('IrsSellerIntegration.tsx', [/Integrasi IRS Seller Masuk<\/h1>/], [/status/, /mapping/, /endpoint/i]);
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

test('audit detail dialog preserves accessible interaction semantics', () => {
    const page = readAdminPage('AuditLogs.tsx');
    const dialog = fs.readFileSync(path.join(root, 'client/src/components/admin/AuditLogDetailDialog.tsx'), 'utf8');
    assert.match(page, /AuditLogDetailDialog/);
    assert.match(page, /parseAuditLogSearchParams/);
    assert.match(page, /serializeAuditLogQuery/);
    assert.match(page, /validateAuditLogDraft/);
    assert.match(page, /auditPaginationRange/);
    assert.match(page, /auditPageCorrection/);
    assert.match(page, /Cari aktivitas/);
    assert.match(page, /Tanggal mulai/);
    assert.match(page, /Tanggal akhir/);
    assert.match(page, /aria-busy/);
    assert.match(page, /role="status"/);
    assert.match(page, /role="alert"/);
    assert.match(page, /Coba lagi/);
    assert.match(page, /Pagination log audit/);
    assert.match(page, /Export CSV membutuhkan izin Kelola Tim dan verifikasi keamanan/);
    assert.match(page, /x-export-truncated/);
    assert.doesNotMatch(page, /onChange=\{\(event\) => \{[\s\S]*fetchLogs/);
    assert.match(dialog, /role="dialog"/);
    assert.match(dialog, /aria-modal="true"/);
    assert.match(dialog, /aria-labelledby/);
    assert.match(dialog, /aria-describedby/);
    assert.match(dialog, /tabIndex=\{-1\}/);
    assert.match(dialog, /Escape/);
    assert.match(dialog, /event\.target === event\.currentTarget/);
    assert.match(dialog, /isConnected/);
    assert.match(dialog, /100dvh/);
    assert.match(dialog, /aria-live="polite"/);
    assert.match(dialog, /\[redacted\]/);
});

test('accessible dialog primitive protects focus, scroll, nesting, and busy close', () => {
    const dialog = fs.readFileSync(path.join(root, 'client/src/components/admin/AccessibleDialog.tsx'), 'utf8');
    assert.match(dialog, /role="dialog"/);
    assert.match(dialog, /aria-modal=\{exclusiveModal \? 'true' : 'false'\}/);
    assert.match(dialog, /aria-labelledby=\{titleId\}/);
    assert.match(dialog, /aria-describedby=\{descriptionId\}/);
    assert.match(dialog, /initialFocusRef/);
    assert.match(dialog, /returnFocusRef/);
    assert.match(dialog, /parentDialogRef/);
    assert.match(dialog, /busy/);
    assert.match(dialog, /document\.addEventListener\(['"]keydown['"]/);
    assert.match(dialog, /event\.key === ['"]Escape['"]/);
    assert.match(dialog, /event\.key !== ['"]Tab['"]/);
    assert.match(dialog, /previousOverflow/);
    assert.match(dialog, /document\.body\.style\.overflow = previousOverflow/);
    assert.match(dialog, /inert/);
    assert.match(dialog, /document\.body\.children/);
    assert.match(dialog, /previousSiblingInert/);
    assert.match(dialog, /isConnected/);
    assert.match(dialog, /onCloseRef\.current\(\)/);
});

test('image picker exposes nested accessible semantics and folder-restricted selection', () => {
    const picker = fs.readFileSync(path.join(root, 'client/src/components/admin/ImagePicker.tsx'), 'utf8');
    const field = fs.readFileSync(path.join(root, 'client/src/components/admin/ImagePickerField.tsx'), 'utf8');
    const sliders = readAdminPage('Sliders.tsx');
    assert.match(picker, /AccessibleDialog/);
    assert.match(picker, /aria-label="Tutup pemilih gambar"/);
    assert.match(picker, /aria-label=\{`Hapus gambar/);
    assert.match(picker, /role="tab"/);
    assert.match(picker, /aria-selected/);
    assert.match(picker, /aria-pressed=\{selectedUrl === file\.url\}/);
    assert.match(picker, /type="button"/);
    assert.match(picker, /role="alert"/);
    assert.match(picker, /ASSET_IN_USE/);
    assert.doesNotMatch(picker, /confirm\(/, 'image deletion must use the nested accessible confirmation');
    assert.match(picker, /restrictSelectionTo\?/);
    assert.match(picker, /const canConfirm = Boolean/);
    assert.match(picker, /activeTab === restrictSelectionTo/);
    assert.match(picker, /disabled=\{!canConfirm \|\| dialogBusy\}/);
    assert.match(picker, /\{ id: 'icons'/);
    assert.match(picker, /\{ id: 'covers'/);
    assert.match(picker, /\{ id: 'popups'/);
    assert.match(picker, /\{ id: 'instructions'/);
    assert.match(field, /restrictSelectionTo/);
    assert.match(sliders, /folder="covers"/);
    assert.match(sliders, /restrictSelectionTo="covers"/);
    assert.match(field, /restrictSelectionTo=\{restrictSelectionTo\}/);
    assert.match(field, /parentDialogRef/);
    assert.doesNotMatch(field, /restrictSelectionTo=\{restrictSelectionTo \?\? folder\}/);
});

test('slider administration uses the revisioned lifecycle and accessible state contracts', () => {
    const sliders = readAdminPage('Sliders.tsx');
    assert.match(sliders, /Backend slider belum siap untuk mutasi revisioned/);
    assert.match(sliders, /Aktif & Draft/);
    assert.match(sliders, /Arsip/);
    assert.match(sliders, /Revision/);
    assert.match(sliders, /Slider saat ini/);
    assert.match(sliders, /Kapasitas total/);
    assert.match(sliders, /Kapasitas aktif/);
    assert.match(sliders, /Total arsip/);
    assert.match(sliders, /sliderStatusLabel\(archived \? 'archive' : 'current', slider\.status\)/);
    assert.match(sliders, /sliderStatusLabel/);
    assert.match(sliders, /formatArchivedMeta/);
    assert.doesNotMatch(sliders, /Current total/);
    assert.doesNotMatch(sliders, /Current active/);
    assert.doesNotMatch(sliders, /Snapshot baca saja/);
    assert.match(sliders, /\/sliders\/admin\/archived/);
    assert.match(sliders, /\/sliders\/admin\/create/);
    assert.match(sliders, /\/sliders\/admin\/.+\/archive/);
    assert.match(sliders, /\/sliders\/admin\/.+\/restore/);
    assert.match(sliders, /\/sliders\/admin\/reorder/);
    assert.doesNotMatch(sliders, /apiV2\.delete/);
    assert.doesNotMatch(sliders, /\/sliders\/admin\/sort-order/);
    assert.match(sliders, /sliderErrorMessage/);
    assert.match(sliders, /error\?\.response\?\.data\?\.error/);
    assert.match(sliders, /AccessibleDialog/);
    assert.match(sliders, /role="alert"/);
    assert.match(sliders, /role="tabpanel"/);
    assert.match(sliders, /aria-controls="slider-current-panel"/);
    assert.match(sliders, /aria-controls="slider-archive-panel"/);
    assert.match(sliders, /canActivateSlider/);
    assert.match(sliders, /Kapasitas slider aktif penuh/);
    assert.match(sliders, /sliderPositionLabel/);
    assert.match(sliders, /Naikkan/);
    assert.match(sliders, /Turunkan/);
    assert.match(sliders, /Muat snapshot terbaru/);
    assert.match(sliders, /Terapkan perubahan tanpa konflik/);
    assert.match(sliders, /Buang perubahan draft/);
    assert.match(sliders, /Buka log audit/);
    assert.doesNotMatch(sliders, /> Segarkan</);
    assert.doesNotMatch(sliders, /Move Up|Move Down|Load Latest Snapshot|Open Audit/);
    assert.match(sliders, /previousSliders/);
    assert.match(sliders, /SLIDER_VERSION_CONFLICT/);
    assert.match(sliders, /SLIDER_COMMIT_UNKNOWN/);
    assert.doesNotMatch(sliders, /Retry Mutation/);
    assert.match(sliders, /aria-label=\{`Edit slider/);
    assert.match(sliders, /aria-label=\{`Arsipkan slider/);
    assert.match(sliders, /aria-label=\{`Pulihkan slider/);
    assert.match(sliders, /hidden md:table/);
});

test('slider form preserves edit-trigger focus and explains public impact', () => {
    const sliders = readAdminPage('Sliders.tsx');
    assert.match(sliders, /formReturnFocusRef/);
    assert.match(sliders, /event\.currentTarget/);
    assert.match(sliders, /Dampak publik/);
    assert.match(sliders, /Rust tetap authoritative/);
    assert.match(sliders, /parentDialogRef=\{formDialogRef\}/);
});

test('slider step-up dialog remains interactive above an inert app background', () => {
    const orchestration = fs.readFileSync(path.join(root, 'client/src/auth/useStepUpOrchestration.tsx'), 'utf8');
    const dialog = fs.readFileSync(path.join(root, 'client/src/components/admin/AccessibleDialog.tsx'), 'utf8');
    const stepUp = fs.readFileSync(path.join(root, 'client/src/components/auth/StepUpDialog.tsx'), 'utf8');
    assert.match(orchestration, /createPortal/);
    assert.match(orchestration, /document\.body/);
    assert.match(stepUp, /data-step-up-dialog="true"/);
    assert.match(dialog, /data-step-up-dialog/);
    assert.match(dialog, /MutationObserver/);
    assert.match(dialog, /aria-modal/);
});

test('seller center shell hierarchy, refresh, and accessibility contracts hold', () => {
    const shell = readAdminPage('DigiflazzSellerCenter.tsx');
    for (const contract of [
        /admin:refresh-current-page/,
        /parseSellerCenterSection/,
        /parseSellerCenterSummary/,
        /latestSummaryRequestId/,
        /aria-busy/,
        /aria-label="Navigasi Digiflazz Seller Center"/,
        /role="status"/,
        /role="alert"/,
        /stepUp\.dialog/,
    ]) {
        assert.match(shell, contract, `seller center shell missing ${contract}`);
    }

    // The two legacy admin pages are removed and cannot be revived as a second surface.
    for (const legacy of ['DigiflazzSellerSettings.tsx', 'IrsSellerSettings.tsx']) {
        assert.equal(fs.existsSync(path.join(root, 'client/src/pages/admin', legacy)), false, `${legacy} must be removed`);
    }

    // Children consume the global refresh revision; neither owns a pure Refresh button.
    for (const child of ['DigiflazzSellerChannel.tsx', 'IrsSellerIntegration.tsx']) {
        const source = readAdminPage(child);
        assert.match(source, /refreshRevision/, `${child} must consume the shell refresh revision`);
        assert.doesNotMatch(source, />\s*Refresh\s*</, `${child} must not own a pure Refresh button`);
    }

    const addOns = readAdminPage('AddOns.tsx');
    const cardMatches = addOns.match(/digiflazz-seller-center/g) || [];
    assert.ok(cardMatches.length >= 1, 'Add Ons must link the canonical seller center card');
    assert.equal((addOns.match(/\/admin\/addons\/irs-seller/g) || []).length, 0, 'Add Ons must not link the legacy IRS page');
    assert.equal((addOns.match(/\/admin\/addons\/digiflazz-seller['"`]/g) || []).length, 0, 'Add Ons must not link the legacy seller page');
    assert.match(addOns, /Digiflazz API/);
    assert.match(addOns, /Integrasi IRS/);
});

test('seller center irs integration keeps credential fields write-only', () => {
    const irs = readAdminPage('IrsSellerIntegration.tsx');
    assert.match(irs, /passwordConfigured/);
    assert.match(irs, /pinConfigured/);
    assert.match(irs, /secretConfigured/);
    assert.doesNotMatch(irs, /passwordMasked|pinMasked|secretMasked/);
    assert.match(irs, /integrations\.credentials/);
    assert.match(irs, /type="password"/);
});
