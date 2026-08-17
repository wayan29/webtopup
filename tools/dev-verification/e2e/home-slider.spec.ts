import { expect, test } from '@playwright/test';
import { MongoClient, ObjectId } from 'mongodb';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(__dirname, '..', '..', '..');

test.describe.configure({ timeout: 90_000 });

async function readEnv(file: string): Promise<Record<string, string>> {
  return Object.fromEntries((await fs.readFile(file, 'utf8')).split(/\r?\n/u).filter(Boolean).map((line) => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1)];
  }));
}

test('homepage slider exposes only active safe links and accessible controls', async ({ page }, testInfo) => {
  const shared = await readEnv(path.join(root, '.dev-verification', 'env', 'shared.env'));
  expect(shared.LOCAL_DEV_VERIFICATION).toBe('true');
  expect(shared.MONGO_DB).toBe('webtopup_task14_dev');
  const manifest = JSON.parse(await fs.readFile(path.join(root, '.dev-verification', 'fixture-manifest.json'), 'utf8')) as Array<{ alias: string; fixtureRunId: string }>;
  const fixtureRunId = manifest.find((item) => item.alias === 'slider-manager')?.fixtureRunId;
  expect(fixtureRunId).toBeTruthy();
  const client = new MongoClient(shared.MONGO_URI);
  await client.connect();
  const db = client.db(shared.MONGO_DB);
  const ids: ObjectId[] = [];
  const prefix = `Task17 home-only ${crypto.randomUUID()}`;
  try {
    for (const [index, link] of [[0, 'https://example.com/promo'], [1, '/internal-promo']] as const) {
      const id = new ObjectId();
      ids.push(id);
      await db.collection('sliders').insertOne({
        _id: id,
        name: `${prefix} ${index}`,
        image: `/uploads/covers/task17-home-${index}.png`,
        link,
        sortOrder: index,
        status: true,
        lifecycle: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
        task17Fixture: true,
        fixtureRunId,
      });
    }
    const inactiveId = new ObjectId();
    ids.push(inactiveId);
    await db.collection('sliders').insertOne({
      _id: inactiveId,
      name: `${prefix} inactive`,
      image: '/uploads/covers/task17-home-inactive.png',
      link: 'https://example.com/inactive',
      sortOrder: 2,
      status: false,
      lifecycle: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
      task17Fixture: true,
      fixtureRunId,
    });

    if (testInfo.project.name === 'chromium-mobile') await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    const carousel = page.getByRole('region', { name: 'Carousel promo' });
    await expect(carousel).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(`${prefix} inactive`, { exact: true })).toHaveCount(0);
    const first = page.getByRole('link', { name: `${prefix} 0` });
    await expect(first).toBeVisible({ timeout: 20_000 });
    await expect(first).toHaveAttribute('target', '_blank');
    await expect(first).toHaveAttribute('rel', /noopener noreferrer/);
    await expect(carousel.getByRole('link', { name: 'Lihat Produk' })).toHaveAttribute('href', '#kategori-produk');
    await expect(carousel.getByRole('link', { name: 'Cek Pesanan' })).toHaveAttribute('href', '/check-transaction');
    await expect(page.getByRole('button', { name: 'Slide sebelumnya' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Slide berikutnya' })).toBeVisible();

    const active = carousel.locator('button[aria-current="true"]');
    await expect(active).toHaveAttribute('aria-label', 'Tampilkan slide 1');
    await page.getByRole('button', { name: 'Jeda otomatis' }).click();
    await page.waitForTimeout(5_500);
    await expect(active).toHaveAttribute('aria-label', 'Tampilkan slide 1');
    await page.getByRole('button', { name: 'Putar otomatis' }).click();
    await expect.poll(async () => active.getAttribute('aria-label'), { timeout: 7_000 }).toBe('Tampilkan slide 2');

    await carousel.dispatchEvent('pointerdown', { pointerId: 19, clientX: 240, clientY: 120, pointerType: 'touch' });
    await carousel.dispatchEvent('pointerup', { pointerId: 19, clientX: 80, clientY: 124, pointerType: 'touch' });
    await expect.poll(async () => active.getAttribute('aria-label'), { timeout: 2_000 }).toBe('Tampilkan slide 1');
    expect(new URL(page.url()).pathname).toBe('/');
  } finally {
    await db.collection('sliders').deleteMany({ _id: { $in: ids }, task17Fixture: true, fixtureRunId });
    await client.close();
  }
});
