import { expect, test } from '@playwright/test';
import { loginFixture } from './fixtures.ts';

test.describe.configure({ timeout: 90_000 });

test('team access review is accessible on desktop and mobile', async ({ page }, testInfo) => {
    const mobile = testInfo.project.name === 'chromium-mobile';
    const viewerAlias = `team-access-viewer-${mobile ? 'mobile' : 'desktop'}`;
    const fixture = await loginFixture(viewerAlias);

    await page.goto(fixture.loginPath);
    await page.getByLabel('Email').fill(fixture.email);
    await page.getByLabel('Password').fill(fixture.password);
    await page.getByRole('button', { name: 'Masuk sekarang' }).click();
    await expect(page).toHaveURL(/\/admin\/dashboard$/);

    await page.goto('/admin/teams');
    await expect(page.getByRole('columnheader', { name: 'Akses efektif' })).toBeVisible();

    const ownerName = 'Task 14 team-access-owner-target';
    const ownerTrigger = page.getByRole('button', { name: `Lihat akses ${ownerName}` });
    await expect(ownerTrigger).toBeVisible();
    await ownerTrigger.click();

    const dialog = page.getByRole('dialog', { name: new RegExp(`Akses efektif · ${ownerName}`) });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Akses penuh', { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true);

    await page.keyboard.press('Tab');
    await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true);
    await page.keyboard.press('Shift+Tab');
    await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true);

    if (mobile) {
        const personalSecurity = dialog.getByRole('heading', { name: 'Keamanan pribadi' });
        await personalSecurity.scrollIntoViewIfNeeded();
        await expect(personalSecurity).toBeVisible();
        await expect(dialog.getByText('Cabut semua sesi', { exact: true })).toBeVisible();
    }

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(ownerTrigger).toBeFocused();

    const suspendedRow = page.locator('tr').filter({ hasText: 'Task 14 team-access-suspended-target' });
    await expect(suspendedRow.getByText('Akses ditangguhkan', { exact: true })).toBeVisible();
});
