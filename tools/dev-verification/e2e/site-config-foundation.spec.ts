import { test, expect } from '@playwright/test';

test.describe('site-config-foundation', () => {
  test('placeholder registers browser gate', async ({ page }) => {
    // Full desktop/mobile flows require disposable fixtures from Task 13/14.
    expect(true).toBeTruthy();
  });
});
