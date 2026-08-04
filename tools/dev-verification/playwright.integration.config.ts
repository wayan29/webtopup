import base from './playwright.config.ts';
import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

export default defineConfig({
  ...base,
  testDir: path.join(__dirname, 'integration'),
  projects: [{ name: 'chromium-desktop', use: { ...devices['Desktop Chrome'] } }],
  reporter: [['line']],
});
