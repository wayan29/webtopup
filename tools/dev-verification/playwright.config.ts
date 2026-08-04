import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { verificationCertificateSpki } from './certificate.ts';

const root = path.resolve(__dirname, '..', '..');
const isolatedChrome = process.env.DEV_VERIFICATION_CHROME_EXECUTABLE?.trim();
const certificateSpki = verificationCertificateSpki(root);

export default defineConfig({
  testDir: path.join(__dirname, 'e2e'),
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['json', { outputFile: '../../.dev-verification/reports/playwright.json' }]],
  use: {
    baseURL: 'https://webtopup.local.test:9443',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    launchOptions: {
      ...(isolatedChrome ? { executablePath: isolatedChrome } : {}),
      args: [
        '--host-resolver-rules=MAP webtopup.local.test 127.0.0.1',
        `--ignore-certificate-errors-spki-list=${certificateSpki}`,
      ],
    },
  },
  projects: [
    { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'chromium-mobile', use: { ...devices['Pixel 7'] } },
  ],
});
