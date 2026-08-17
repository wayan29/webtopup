import { expect, test, type Page } from '@playwright/test';
import { MongoClient, ObjectId } from 'mongodb';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixtureOtp, loginFixture } from './fixtures.ts';

const root = path.resolve(__dirname, '..', '..', '..');
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

type Env = Record<string, string>;

test.describe.configure({ timeout: 120_000 });

async function staffLogin(page: Page) {
  await page.goto('/staff/login');
  await expect(page.getByLabel('Email')).toBeVisible();
  const fixture = await loginFixture('slider-manager');
  await page.getByLabel('Email').fill(fixture.email);
  await page.getByLabel('Password').fill(fixture.password);
  await page.getByRole('button', { name: 'Masuk sekarang' }).click();
  await expect(page.getByLabel('Kode OTP')).toBeVisible({ timeout: 20_000 });
  await page.getByLabel('Kode OTP').fill(await fixtureOtp('slider-manager'));
  await page.getByRole('button', { name: 'Verifikasi & masuk' }).click();
  await expect(page).toHaveURL(/\/admin\/dashboard$/, { timeout: 20_000 });
}

async function envFile(file: string): Promise<Env> {
  return Object.fromEntries((await fs.readFile(file, 'utf8')).split(/\r?\n/u).filter(Boolean).map((line) => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1)];
  }));
}

async function markedMongo() {
  const shared = await envFile(path.join(root, '.dev-verification', 'env', 'shared.env'));
  expect(shared.LOCAL_DEV_VERIFICATION).toBe('true');
  expect(shared.MONGO_DB).toBe('webtopup_task14_dev');
  const manifest = JSON.parse(await fs.readFile(path.join(root, '.dev-verification', 'fixture-manifest.json'), 'utf8')) as Array<{ alias: string; fixtureRunId: string }>;
  const fixtureRunId = manifest.find((item) => item.alias === 'slider-manager')?.fixtureRunId;
  expect(fixtureRunId).toBeTruthy();
  const client = new MongoClient(shared.MONGO_URI);
  await client.connect();
  return { client, db: client.db(shared.MONGO_DB), fixtureRunId: fixtureRunId as string };
}

async function cleanupSliderFixture(db: ReturnType<MongoClient['db']>, fixtureRunId: string, prefix: string, uploadedCoverUrl?: string) {
  const sliders = await db.collection('sliders').find({ task17Fixture: true, fixtureRunId, name: { $regex: `^${prefix}` } }, { projection: { _id: 1 } }).toArray();
  const ids = sliders.map((slider) => slider._id);
  for (const slider of sliders) {
    await db.collection('managedassetreferences').deleteMany({ resourceType: 'slider', resourceId: slider._id });
    await db.collection('sliders').deleteOne({ _id: slider._id, task17Fixture: true, fixtureRunId });
  }
  if (ids.length) {
    await db.collection('slideridempotencyclaims').deleteMany({ $or: [{ targetId: { $in: ids } }, { candidateSliderId: { $in: ids } }] });
    await db.collection('slideraudits').deleteMany({ targetId: { $in: ids } });
  }
  if (uploadedCoverUrl) {
    const asset = await db.collection('managedassets').findOne({ canonicalPath: uploadedCoverUrl, task17Fixture: true, fixtureRunId }, { projection: { _id: 1 } });
    if (asset) {
      await db.collection('managedassetreferences').deleteMany({ assetId: asset._id });
      await db.collection('managedassets').deleteOne({ _id: asset._id, task17Fixture: true, fixtureRunId });
      await fs.rm(path.join(root, uploadedCoverUrl.replace(/^\/uploads\//u, 'uploads/')), { force: true });
    }
  }
}

async function markCreatedSlider(page: Page, db: ReturnType<MongoClient['db']>, fixtureRunId: string, name: string) {
  const slider = await db.collection('sliders').findOne({ name, task17Fixture: { $ne: true } });
  expect(slider?._id).toBeTruthy();
  await db.collection('sliders').updateOne({ _id: slider!._id }, { $set: { task17Fixture: true, fixtureRunId, task17Test: true } });
  return slider!._id as ObjectId;
}

test('admin slider lifecycle is accessible, revisioned, and split-deploy gated', async ({ page }, testInfo) => {
  await staffLogin(page);
  const { client, db, fixtureRunId } = await markedMongo();
  const prefix = `Task17 browser ${crypto.randomUUID()}`;
  const seedId = new ObjectId();
  await db.collection('sliders').insertOne({ _id: seedId, name: `${prefix} seed`, image: '/uploads/covers/task17-seed-missing.png', link: '/task17-seed', sortOrder: 0, status: false, lifecycle: 'active', createdAt: new Date(), updatedAt: new Date(), task17Fixture: true, fixtureRunId });
  let createdName = `${prefix} draft`;
  let createdId: ObjectId | undefined;
  let uploadedCoverUrl: string | undefined;
  try {
    await page.goto('/admin/sliders');
    await expect(page.getByRole('tab', { name: 'Aktif & Draft' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Revision', { exact: true })).toBeVisible();
    if (testInfo.project.name === 'chromium-mobile') {
      await expect(page.getByText('Move Up', { exact: true }).first()).toBeVisible();
    } else {
      await expect(page.locator('table')).toBeVisible();
    }

    // A legacy array can render but must disable every mutation affordance.
    await page.route('**/api/v2/sliders/admin/all', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/v2/sliders/admin/archived', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.reload();
    await expect(page.getByText('Backend slider belum siap untuk mutasi revisioned')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Tambah Slider' })).toBeDisabled();
    await page.unroute('**/api/v2/sliders/admin/all');
    await page.unroute('**/api/v2/sliders/admin/archived');
    await page.reload();
    await expect(page.getByRole('button', { name: 'Tambah Slider' })).toBeEnabled({ timeout: 30_000 });

    const add = page.getByRole('button', { name: 'Tambah Slider' });
    await add.focus();
    await add.click();
    const formDialog = page.getByRole('dialog', { name: 'Tambah Slider' });
    await expect(formDialog).toBeVisible();
    await expect(page.getByLabel('Nama Slider')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(formDialog).toHaveCount(0);
    await expect(add).toBeFocused();

    await add.click();
    await page.getByLabel('Nama Slider').fill(createdName);
    await page.getByRole('button', { name: 'Pilih Gambar' }).click();
    const picker = page.getByRole('dialog', { name: 'Pilih Gambar' });
    await expect(picker).toBeVisible();
    const dialogs = page.locator('[data-accessible-dialog="true"]');
    await expect(dialogs).toHaveCount(2);
    await expect(dialogs.first()).toHaveAttribute('inert', '');
    const uploadedFilename = `task17-${crypto.randomUUID()}.png`;
    const uploadResponse = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().includes('/api/v2/upload?type=covers'));
    await page.getByLabel('Upload gambar baru').setInputFiles({ name: uploadedFilename, mimeType: 'image/png', buffer: PNG_1X1 });
    const uploadBody = await (await uploadResponse).json() as { url?: string };
    expect(uploadBody.url).toMatch(/^\/uploads\/covers\//u);
    uploadedCoverUrl = uploadBody.url;
    const uploadedAsset = await db.collection('managedassets').findOne({ canonicalPath: uploadedCoverUrl });
    expect(uploadedAsset?._id).toBeTruthy();
    await db.collection('managedassets').updateOne({ _id: uploadedAsset!._id }, { $set: { task17Fixture: true, fixtureRunId } });
    const imageButton = picker.getByRole('button', { name: new RegExp(`Pilih ${uploadedFilename}`) });
    await expect(imageButton).toBeVisible({ timeout: 20_000 });
    await imageButton.click();
    await page.getByRole('button', { name: 'Konfirmasi pilih gambar' }).click();
    await expect(picker).toHaveCount(0);
    await page.getByLabel('Link (opsional)').fill('/task17-browser');
    const createResponse = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().includes('/api/v2/sliders/admin/create'));
    await page.getByRole('button', { name: 'Simpan Slider' }).click();
    expect((await createResponse).status()).toBe(201);
    await expect(page.getByText('Slider berhasil ditambahkan', { exact: false })).toBeVisible({ timeout: 20_000 });
    createdId = await markCreatedSlider(page, db, fixtureRunId, createdName);

    // Publishing a draft invokes step-up and retries the same intent key.
    const requestKeys: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'PUT' && request.url().includes(`/api/v2/sliders/admin/${createdId!.toHexString()}`)) {
        const key = request.headers()['idempotency-key'];
        if (key) requestKeys.push(key);
      }
    });
    await page.getByRole('button', { name: `Edit slider ${createdName}` }).click();
    await page.getByText('Publikasikan sebagai slider aktif', { exact: true }).click();
    await page.getByRole('button', { name: 'Simpan Slider' }).click();
    await expect(page.getByRole('heading', { name: 'Verifikasi ulang diperlukan' })).toBeVisible({ timeout: 20_000 });
    await page.getByLabel('Password', { exact: true }).fill((await loginFixture('slider-manager')).password);
    await page.getByLabel('Kode OTP').fill(await fixtureOtp('slider-manager'));
    await page.getByRole('button', { name: 'Lanjutkan' }).click();
    await expect(page.getByText('Slider berhasil diperbarui', { exact: false })).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => requestKeys.length, { timeout: 20_000 }).toBe(2);
    expect(requestKeys[0]).toBe(requestKeys[1]);
    await expect(page.getByText('Aktif', { exact: true }).first()).toBeVisible();

    // Archive and restore use explicit accessible dialogs and preserve draft restore semantics.
    await page.getByRole('button', { name: `Arsipkan slider ${createdName}` }).first().click();
    await expect(page.getByRole('dialog', { name: 'Arsipkan slider?' })).toBeVisible();
    await page.getByRole('button', { name: 'Arsipkan Slider' }).click();
    await expect(page.getByRole('heading', { name: 'Verifikasi ulang diperlukan' })).toBeVisible({ timeout: 20_000 });
    await page.getByLabel('Password', { exact: true }).fill((await loginFixture('slider-manager')).password);
    await page.getByLabel('Kode OTP').fill(await fixtureOtp('slider-manager'));
    await page.getByRole('button', { name: 'Lanjutkan' }).click();
    await expect(page.getByText(`Slider "${createdName}" berhasil diarsipkan`, { exact: false })).toBeVisible({ timeout: 20_000 });
    await page.getByRole('tab', { name: 'Arsip' }).click();
    await expect(page.getByText(createdName, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: `Restore slider ${createdName}` }).click();
    await expect(page.getByRole('dialog', { name: 'Restore slider?' })).toBeVisible();
    await page.getByRole('button', { name: 'Restore sebagai Draft' }).click();
    await expect(page.getByText(`Slider "${createdName}" berhasil direstore sebagai draft`, { exact: false })).toBeVisible({ timeout: 20_000 });

    // A mocked conflict/unknown response verifies UI safety without mutating backend state.
    await page.getByRole('tab', { name: 'Aktif & Draft' }).click();
    await page.getByRole('button', { name: `Edit slider ${createdName}` }).click();
    await page.getByLabel('Nama Slider').fill(`${createdName} conflict`);
    await page.route(`**/api/v2/sliders/admin/${createdId.toHexString()}`, async (route) => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SLIDER_VERSION_CONFLICT', message: 'Daftar slider telah berubah', expectedRevision: 1, currentRevision: 2, currentSnapshot: { revision: 2, sliders: [], limits: { total: 20, active: 8, currentTotal: 0, currentActive: 0, remainingTotal: 20, remainingActive: 8 } } } }) }));
    await page.getByRole('button', { name: 'Simpan Slider' }).click();
    await expect(page.getByRole('heading', { name: 'Konflik revision slider' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: 'Load Latest Snapshot' })).toBeVisible();
    await page.unroute(`**/api/v2/sliders/admin/${createdId.toHexString()}`);
    await page.getByRole('button', { name: 'Discard Draft' }).click();
  } finally {
    await cleanupSliderFixture(db, fixtureRunId, prefix, uploadedCoverUrl);
    await client.close();
  }
});
