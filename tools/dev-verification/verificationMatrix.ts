export type MatrixProfile = 'none' | 'disabled' | 'session-cs' | 'session-cs-fault' | 'session-device-policy' | 'session-finance-policy' | 'session-finance-fault' | 'self-managed' | 'stopped';
export type MatrixCheck = { name: string; required: true; profile: MatrixProfile; isolated?: boolean; command: string; args: readonly string[] };
const check = (name: string, profile: MatrixProfile, command: string, args: readonly string[], isolated = false): MatrixCheck => ({ name, required: true, profile, command, args, isolated });
const sessionSpecs = ['session-cookies', 'session-lifecycle', 'session-multitab', 'session-multitab-logout', 'session-convergence', 'session-refresh-race', 'session-response-loss', 'session-rotation', 'session-safe-get-replay', 'session-family-replay', 'session-current-logout', 'session-all-logout', 'session-target-revoke', 'session-expiry', 'session-step-up'] as const;
const deviceSpecs = ['session-device-replacement', 'session-enrollment'] as const;
const browserCheck = (spec: string, project: 'chromium-desktop' | 'chromium-mobile', profile: 'session-cs' | 'session-cs-fault' | 'session-device-policy'): MatrixCheck =>
  check(`${spec}-${project === 'chromium-desktop' ? 'desktop' : 'mobile'}`, profile, 'npx', ['playwright', 'test', '--config', 'tools/dev-verification/playwright.config.ts', `${spec}.spec.ts`, `--project=${project}`, '--workers=1'], true);

export const verificationMatrix = (): readonly MatrixCheck[] => [
  check('unit', 'none', 'npm', ['run', 'test:dev-verify:unit']),
  check('client-build', 'none', 'npm', ['--prefix', 'client', 'run', 'build']),
  check('server-build', 'none', 'npm', ['--prefix', 'server', 'run', 'build']),
  check('rust-build', 'none', 'npm', ['run', 'api-v2:build']),
  check('mongo', 'disabled', 'node', ['--import', 'tsx', '--test', 'tools/dev-verification/integration/mongo.test.ts'], true),
  check('public-origin', 'session-device-policy', 'npx', ['playwright', 'test', '--config', 'tools/dev-verification/playwright.config.ts', 'public-origin.spec.ts', '--project=chromium-desktop', '--workers=1'], true),
  check('login-return-to-desktop', 'session-device-policy', 'npx', ['playwright', 'test', '--config', 'tools/dev-verification/playwright.config.ts', 'login-return-to.spec.ts', '--project=chromium-desktop', '--workers=1'], true),
  ...sessionSpecs.flatMap((spec) => { const profile = spec === 'session-refresh-race' || spec === 'session-response-loss' ? 'session-cs-fault' : 'session-cs'; return [browserCheck(spec, 'chromium-desktop', profile), browserCheck(spec, 'chromium-mobile', profile)]; }),
  ...deviceSpecs.flatMap((spec) => [browserCheck(spec, 'chromium-desktop', 'session-device-policy'), browserCheck(spec, 'chromium-mobile', 'session-device-policy')]),
  check('team-access-desktop', 'session-cs', 'npx', ['playwright', 'test', '--config', 'tools/dev-verification/playwright.config.ts', 'team-access.spec.ts', '--project=chromium-desktop', '--workers=1'], true),
  check('team-access-mobile', 'session-cs', 'npx', ['playwright', 'test', '--config', 'tools/dev-verification/playwright.config.ts', 'team-access.spec.ts', '--project=chromium-mobile', '--workers=1'], true),
  check('catalog-permissions', 'session-cs', 'node', ['--import', 'tsx', '--test', 'tools/dev-verification/integration/catalogPermissions.test.ts'], true),
  check('audit-logs-integration', 'session-cs', 'npx', ['playwright', 'test', '--config', 'tools/dev-verification/playwright.integration.config.ts', 'auditLogs.test.ts', '--project=chromium-desktop', '--workers=1'], true),
  check('audit-logs-desktop', 'session-cs', 'npx', ['playwright', 'test', '--config', 'tools/dev-verification/playwright.config.ts', 'audit-logs.spec.ts', '--project=chromium-desktop', '--workers=1'], true),
  check('audit-logs-mobile', 'session-cs', 'npx', ['playwright', 'test', '--config', 'tools/dev-verification/playwright.config.ts', 'audit-logs.spec.ts', '--project=chromium-mobile', '--workers=1'], true),
  check('finance-idempotency', 'session-finance-fault', 'npx', ['playwright', 'test', '--config', 'tools/dev-verification/playwright.integration.config.ts', 'idempotency.test.ts', '--project=chromium-desktop', '--workers=1'], true),
  check('giveaway-atomic', 'session-finance-policy', 'node', ['--import', 'tsx', '--test', 'tools/dev-verification/integration/giveawayAtomic.test.ts'], true),
    check('upload-security', 'session-cs', 'node', ['--import', 'tsx', '--test', 'tools/dev-verification/integration/uploadSecurity.test.ts'], true),
  check('identifier-integrity', 'session-device-policy', 'node', ['--import', 'tsx', '--test', 'tools/dev-verification/integration/identifierIntegrity.test.ts'], true),
  check('site-config-foundation', 'session-cs-fault', 'node', ['--import', 'tsx', '--test', 'tools/dev-verification/integration/siteConfigFoundation.test.ts'], true),
  check('site-config-foundation-desktop', 'session-cs-fault', 'npx', ['playwright', 'test', '--config', 'tools/dev-verification/playwright.config.ts', 'site-config-foundation.spec.ts', '--project=chromium-desktop', '--workers=1'], true),
  check('site-config-foundation-mobile', 'session-cs-fault', 'npx', ['playwright', 'test', '--config', 'tools/dev-verification/playwright.config.ts', 'site-config-foundation.spec.ts', '--project=chromium-mobile', '--workers=1'], true),
  check('slider-management', 'session-cs-fault', 'node', ['--import', 'tsx', '--test', 'tools/dev-verification/integration/sliderManagement.test.ts'], true),
  check('sliders-desktop', 'session-cs-fault', 'npx', ['playwright', 'test', '--config', 'tools/dev-verification/playwright.config.ts', 'sliders.spec.ts', '--project=chromium-desktop', '--workers=1'], true),
  check('sliders-mobile', 'session-cs-fault', 'npx', ['playwright', 'test', '--config', 'tools/dev-verification/playwright.config.ts', 'sliders.spec.ts', '--project=chromium-mobile', '--workers=1'], true),
  check('home-slider-desktop', 'session-cs', 'npx', ['playwright', 'test', '--config', 'tools/dev-verification/playwright.config.ts', 'home-slider.spec.ts', '--project=chromium-desktop', '--workers=1'], true),
  check('home-slider-mobile', 'session-cs', 'npx', ['playwright', 'test', '--config', 'tools/dev-verification/playwright.config.ts', 'home-slider.spec.ts', '--project=chromium-mobile', '--workers=1'], true),
  check('guest-checkout-idempotency', 'session-finance-fault', 'npx', ['playwright', 'test', '--config', 'tools/dev-verification/playwright.integration.config.ts', 'guestCheckoutIdempotency.test.ts', '--project=chromium-desktop', '--workers=1'], true),
  check('rollout-transition', 'self-managed', 'npx', ['playwright', 'test', '--config', 'tools/dev-verification/playwright.integration.config.ts', 'rollout.spec.ts', '--project=chromium-desktop', '--workers=1']),
  check('diff-check', 'none', 'git', ['diff', '--check']),
  check('report-secrecy', 'none', 'node', ['--import', 'tsx', 'tools/dev-verification/cli.ts', 'audit-reports']),
  check('stopped-state', 'stopped', 'npm', ['run', 'dev-verify', '--', 'status']),
];
