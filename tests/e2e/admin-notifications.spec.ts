import { expect, test } from '@playwright/test';

const screenshotDir = 'test-results/admin-notifications';
const adminStorageState = 'playwright/.auth/admin.json';

test.use({ storageState: adminStorageState });

const stubAdminNotifications = async (
  page: import('@playwright/test').Page,
  unread: number
) => {
  await page.route('**/api/v2/notifications/admin*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        unread,
        total: unread,
        notifications: []
      })
    });
  });
};

test.describe('admin notifications smoke', () => {
  test('opens with severity query param, changes filters, and refreshes in place', async ({ page }, testInfo) => {
    await page.goto('/admin/notifications?severity=critical');

    // The page hero was removed; the layout header owns the page title.
    await expect(page.getByText(/Belum Dibaca/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /Tandai Dibaca/i })).toBeVisible();

    await expect(page.getByRole('button', { name: /^Critical$/i })).toHaveClass(/ui-accent-chip/);

    await page.getByRole('button', { name: /^Warning$/i }).click();
    await expect(page).toHaveURL(/severity=warning/);
    await expect(page.getByRole('button', { name: /^Warning$/i })).toHaveClass(/ui-accent-chip/);

    const urlBeforeRefresh = page.url();
    await page.getByRole('button', { name: /Segarkan Notifikasi/i }).click();
    await expect(page).toHaveURL(urlBeforeRefresh);

    await page.screenshot({ path: `${screenshotDir}/desktop-notifications.png`, fullPage: true });
    await testInfo.attach('desktop-notifications', {
      path: `${screenshotDir}/desktop-notifications.png`,
      contentType: 'image/png'
    });
  });

  test('notifications leave the sidebar and are reachable from the header bell', async ({ page }) => {
    await stubAdminNotifications(page, 120);
    await page.goto('/admin/dashboard');

    const sidebarNav = page.locator('#admin-sidebar nav');
    await expect(sidebarNav.getByRole('link', { name: /^Notifikasi$/ })).toHaveCount(0);

    const bell = page.getByRole('link', { name: /Notifikasi admin, 120 belum dibaca/ });
    await expect(bell).toBeVisible();
    await expect(bell).toHaveAttribute('href', '/admin/notifications');
    await expect(bell).toContainText('99+');

    const box = await bell.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(40);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);

    await bell.click();
    await expect(page).toHaveURL(/\/admin\/notifications/);
  });

  test('header bell stays visible with no unread notifications', async ({ page }) => {
    await stubAdminNotifications(page, 0);
    await page.goto('/admin/dashboard');

    const bell = page.getByRole('link', { name: /Notifikasi admin, tidak ada yang belum dibaca/ });
    await expect(bell).toBeVisible();
    await expect(bell).not.toContainText(/\d/);
  });

  test('mobile notifications layout shows summary, filters, and header controls', async ({ page }, testInfo) => {
    await page.goto('/admin/notifications');

    await expect(page.getByText(/Belum Dibaca/i)).toBeVisible();
    await expect(page.getByText(/Total Alert/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /^Semua$/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Info$/i })).toBeVisible();

    await expect(page.getByRole('link', { name: /Notifikasi admin/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Menu akun$/i })).toBeVisible();

    await page.screenshot({ path: `${screenshotDir}/mobile-notifications.png`, fullPage: true });
    await testInfo.attach('mobile-notifications', {
      path: `${screenshotDir}/mobile-notifications.png`,
      contentType: 'image/png'
    });
  });
});
