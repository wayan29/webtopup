import { expect, test, type Page, type Route } from '@playwright/test';

const settings = {
  brand: 'Danayasa',
  title: 'Danayasa - Top Up Game Termurah',
  favicon: '/danayasa-favicon.svg',
  logo: '/danayasa-logo.svg',
  description: 'Top up aman',
  footerText: '© 2026 Danayasa. All Rights Reserved.',
  registrationEnabled: true,
  maintenanceMode: false,
  maintenanceMessage: '',
  popupBannerEnabled: false,
  popupBannerImage: '',
  popupBannerTitle: '',
  popupBannerDescription: '',
  popupBannerLink: '',
};

const operator = {
  _id: '507f1f77bcf86cd799439011',
  name: 'Operator Uji',
  slug: 'operator-uji',
  status: true,
  checkUsername: false,
  validationType: 'none',
  userIdLabel: 'Nomor Tujuan',
};

const description = '<p>Deskripsi <strong>aman</strong><br><a href="https://example.com" rel="noopener noreferrer">Panduan</a></p>';
const productType = {
  _id: '507f1f77bcf86cd799439012',
  name: 'Jenis Uji',
  slug: 'jenis-uji',
  status: true,
  description,
  popupInfo: { enabled: false, title: '', content: '', image: '', buttonText: '', buttonLink: '' },
};
const product = {
  _id: '507f1f77bcf86cd799439013',
  name: 'Produk Uji',
  code: 'TEST-1',
  category: 'Game',
  categoryId: { _id: '507f1f77bcf86cd799439014', name: 'Game', icon: '🎮' },
  operatorId: { _id: operator._id, name: operator.name },
  productTypeId: { _id: productType._id, name: productType.name },
  brand: operator.name,
  price: { basic: 10_000, gold: 9_000, platinum: 8_000 },
  status: true,
  canPurchase: true,
};
const article = {
  _id: '507f1f77bcf86cd799439015',
  title: 'Artikel Uji',
  slug: 'artikel-uji',
  excerpt: 'Ringkasan artikel uji',
  content: '<p>Isi artikel</p>',
  category: 'Umum',
  status: 'published',
  createdAt: '2026-07-31T00:00:00.000Z',
};

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function mockPublicApi(page: Page, overrides: Record<string, unknown> = {}) {
  await page.route('**/api/v2/**', async (route) => {
    const url = new URL(route.request().url());
    const key = `${route.request().method()} ${url.pathname}`;
    if (Object.prototype.hasOwnProperty.call(overrides, key)) {
      const value = overrides[key];
      if (value === 'malformed') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{broken' });
        return;
      }
      if (value && typeof value === 'object' && 'status' in value) {
        const response = value as { status: number; body?: unknown };
        await fulfillJson(route, response.body ?? { message: 'Kesalahan layanan' }, response.status);
        return;
      }
      await fulfillJson(route, value);
      return;
    }

    if (url.pathname === '/api/v2/auth/refresh') return fulfillJson(route, { error: { code: 'AUTH_SESSION_EXPIRED', message: 'Unauthorized' } }, 401);
    if (url.pathname === '/api/v2/settings/public') return fulfillJson(route, settings);
    if (url.pathname === '/api/v2/categories') return fulfillJson(route, [{ _id: product.categoryId._id, name: 'Game', slug: 'game', icon: '🎮', sortOrder: 1, status: true }]);
    if (url.pathname === '/api/v2/operators') return fulfillJson(route, [operator]);
    if (url.pathname === `/api/v2/operators/${operator._id}` || url.pathname === `/api/v2/operators/${operator.slug}`) return fulfillJson(route, operator);
    if (url.pathname === '/api/v2/product-types') return fulfillJson(route, [productType]);
    if (url.pathname === `/api/v2/product-types/${productType._id}` || url.pathname === `/api/v2/product-types/${productType.slug}`) return fulfillJson(route, productType);
    if (url.pathname === '/api/v2/products') return fulfillJson(route, [product]);
    if (url.pathname === '/api/v2/payment-methods') return fulfillJson(route, []);
    if (url.pathname === '/api/v2/flash-sales/active') return fulfillJson(route, []);
    if (url.pathname.startsWith('/api/v2/flash-sales/')) return fulfillJson(route, { hasFlashSale: false });
    if (url.pathname === '/api/v2/sliders') return fulfillJson(route, []);
    if (url.pathname === '/api/v2/articles') return fulfillJson(route, [article]);
    if (url.pathname === `/api/v2/articles/${article.slug}`) return fulfillJson(route, article);
    if (url.pathname === '/api/v2/leaderboard') return fulfillJson(route, { items: [], currentUser: null, meta: { period: 'monthly', participantCount: 0, totalTransactions: 0, totalAmount: 0, generatedAt: '2026-07-31T00:00:00.000Z' } });
    return fulfillJson(route, []);
  });
}

async function expectUsablePage(page: Page, path = page.url()) {
  await expect(page.locator('#root'), `${path} root content`).not.toBeEmpty();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
}

async function expectPublicControls(page: Page) {
  if (page.viewportSize()?.width && page.viewportSize()!.width < 640) {
    const menu = page.getByRole('button', { name: 'Buka menu navigasi' });
    await menu.focus();
    await expect(menu).toBeFocused();
    await page.keyboard.press('Enter');
  }
  await expect(page.getByRole('link', { name: 'Masuk' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Daftar' })).toBeVisible();
  await expect(page.locator('a[href="/staff/login"]')).toHaveCount(0);
}

test.use({ storageState: { cookies: [], origins: [] } });

test.describe('tracked public behavior', () => {
  test.beforeEach(async ({ context, page }) => {
    await context.clearCookies();
    await page.addInitScript(() => { localStorage.clear(); sessionStorage.clear(); });
    await mockPublicApi(page);
  });

  test('all public routes render usable desktop/mobile states and expose member controls only', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const routes = [
      ['/', /Top up & PPOB/i],
      ['/products', 'Katalog Produk'],
      [`/order/${operator._id}`, operator.name],
      [`/order/${operator._id}/${productType._id}`, productType.name],
      ['/check-transaction', 'Cek Transaksi'],
      ['/leaderboard', 'Leaderboard Member'],
      ['/articles', 'Artikel & Berita'],
      [`/articles/${article.slug}`, article.title],
    ] as const;

    for (const [path, visibleText] of routes) {
      await page.goto(path);
      if (typeof visibleText === 'string') await expect(page.getByText(visibleText, { exact: true }).first()).toBeVisible();
      else await expect(page.getByRole('heading', { name: visibleText })).toBeVisible();
      await page.waitForTimeout(100);
      expect(pageErrors, `${path} page errors`).toEqual([]);
      await expectUsablePage(page, path);
      if (!path.startsWith('/order/')) await expectPublicControls(page);
    }

    await page.goto('/order');
    await expect(page).toHaveURL(/\/$/u);
    await expectUsablePage(page);
  });

  test('login and register remain keyboard accessible and never advertise staff login', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Masuk akun' })).toBeVisible();
    await page.getByLabel('Email').focus();
    await expect(page.getByLabel('Email')).toBeFocused();
    await expect(page.locator('a[href="/staff/login"]')).toHaveCount(0);
    await expectUsablePage(page);

    await page.goto('/register');
    await expect(page.getByRole('heading', { name: 'Buat akun baru' })).toBeVisible();
    await page.getByLabel('Nama lengkap').focus();
    await expect(page.getByLabel('Nama lengkap')).toBeFocused();
    await expect(page.locator('a[href="/staff/login"]')).toHaveCount(0);
    await expectUsablePage(page);
  });

  test('approved description formatting reaches Order and unsafe markup is absent', async ({ page }) => {
    await page.goto(`/order/${operator._id}/${productType._id}`);
    const rendered = page.locator('.prose').filter({ hasText: 'Deskripsi aman' });
    await expect(rendered.locator('p strong')).toHaveText('aman');
    await expect(rendered.locator('br')).toHaveCount(1);
    const link = rendered.getByRole('link', { name: 'Panduan' });
    await expect(link).toHaveAttribute('href', 'https://example.com');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(rendered.locator('script, style, iframe, [onclick], [onerror], a[href^="http:"], a[href^="javascript:"], a[href^="data:"]')).toHaveCount(0);
  });
});

test.describe('public response resilience', () => {
  test('loading and empty public lists do not blank or crash', async ({ page }) => {
    await page.unroute('**/api/v2/**');
    await mockPublicApi(page, { 'GET /api/v2/products': [] });
    let releaseProducts!: () => void;
    const productsGate = new Promise<void>((resolve) => { releaseProducts = resolve; });
    await page.route('**/api/v2/products', async (route) => {
      await productsGate;
      await fulfillJson(route, []);
    });
    await page.goto('/products');
    await expect(page.getByText('Memuat produk...')).toBeVisible();
    releaseProducts();
    await expect(page.getByText('Belum ada produk tersedia.')).toBeVisible();
    await expectUsablePage(page);
  });

  for (const state of [
    { name: 'malformed JSON', value: 'malformed' },
    { name: '4xx', value: { status: 404, body: { message: 'Tidak ditemukan' } } },
    { name: '5xx', value: { status: 500, body: { message: 'Kesalahan layanan' } } },
  ]) {
    test(`${state.name} catalog and article responses show stable error states`, async ({ page }) => {
      await mockPublicApi(page, {
        'GET /api/v2/products': state.value,
        'GET /api/v2/articles': state.value,
      });
      await page.goto('/products');
      await expect(page.getByRole('alert')).toContainText('Katalog belum bisa dimuat');
      await expectUsablePage(page);
      await page.goto('/articles');
      await expect(page.getByRole('alert')).toContainText('Artikel belum bisa dimuat');
      await expectUsablePage(page);
    });
  }

  test('4xx and 5xx order responses remain explanatory instead of blank', async ({ page }) => {
    for (const status of [404, 500]) {
      await mockPublicApi(page, { [`GET /api/v2/operators/${operator._id}`]: { status, body: { message: `Operator ${status}` } } });
      await page.goto(`/order/${operator._id}`);
      await expect(page.getByText(`Operator ${status}`)).toBeVisible();
      await expectUsablePage(page);
    }
  });
});
