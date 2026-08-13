import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixtureDefinitions, loginReturnToFixtureDefinitions, publicFixtureManifest } from '../seed.ts';

test('seeder requires full marked stack readiness before any fixture write', async () => {
  const source = await fs.readFile(path.resolve(import.meta.dirname, '..', 'seed.ts'), 'utf8');
  assert.match(source, /await assertMarkedVerificationDatabaseReady\(config\);[\s\S]*mongoose\.connect/);
});

test('fixture definitions are scenario-isolated and marked', () => {
  const definitions = fixtureDefinitions('run-123', new Date('2026-07-18T00:00:00Z'));
  assert.ok(definitions.length >= 8);
  assert.equal(new Set(definitions.map((item) => item.alias)).size, definitions.length);
  assert.ok(definitions.every((item) => item.task14Fixture === true && item.fixtureRunId === 'run-123'));
  assert.ok(definitions.some((item) => item.scenario === 'staff-overdue-2fa'));
  assert.ok(definitions.some((item) => item.alias === 'staff-step-up-desktop' && item.scenario === 'staff-step-up-desktop'));
  assert.ok(definitions.some((item) => item.alias === 'staff-step-up-mobile' && item.scenario === 'staff-step-up-mobile'));
  assert.ok(definitions.some((item) => item.alias === 'finance-actor' && item.role === 'admin'));
  assert.ok(definitions.some((item) => item.alias === 'finance-target' && item.role === 'member'));
  assert.ok(definitions.some((item) => item.alias === 'team-access-viewer-desktop'));
  assert.ok(definitions.some((item) => item.alias === 'team-access-viewer-mobile'));
  assert.ok(definitions.some((item) => item.alias === 'team-access-owner-target' && item.role === 'owner'));
  assert.ok(definitions.some((item) => item.alias === 'team-access-suspended-target' && item.active === false));
  assert.ok(definitions.some((item) => item.alias === 'catalog-viewer'));
  assert.ok(definitions.some((item) => item.alias === 'catalog-manager'));
  assert.ok(definitions.some((item) => item.alias === 'catalog-viewer' && item.permissions?.viewProducts === true && item.permissions?.manageProducts === false));
  assert.ok(definitions.some((item) => item.alias === 'catalog-manager' && item.permissions?.manageProducts === true));
  assert.ok(definitions.some((item) => item.alias === 'audit-denied' && item.permissions?.viewTeam !== true));
  assert.ok(definitions.some((item) => item.alias === 'team-access-viewer-desktop' && item.permissions?.viewTeam === true && item.permissions?.manageTeam !== true));
  assert.ok(definitions.some((item) => item.alias === 'team-access-viewer-mobile' && item.permissions?.viewTeam === true && item.permissions?.manageTeam !== true));
  assert.ok(definitions.some((item) => item.alias === 'audit-manager' && item.role === 'cs' && item.twoFactorEnabled === true && item.permissions?.manageTeam === true && item.permissions?.manageProducts === true));
  assert.ok(definitions.some((item) => item.alias === 'site-config-denied' && item.role === 'cs' && item.active === true && item.permissions?.manageSettings !== true && item.permissions?.manageTeam !== true && item.permissions?.manageProducts !== true));
  assert.ok(definitions.some((item) => item.alias === 'site-config-manager' && item.role === 'cs' && item.active === true && item.twoFactorEnabled === true && item.permissions?.manageSettings === true));
  assert.ok(definitions.some((item) => item.alias === 'site-config-inactive' && item.role === 'cs' && item.active === false && item.twoFactorEnabled === true && item.permissions?.manageSettings === true));
  assert.ok(definitions.some((item) => item.alias === 'identifier-member' && item.role === 'member' && item.active === true && item.syntheticBalance === 100_000 && item.twoFactorEnabled === false));
  assert.ok(definitions.some((item) => item.scenario === 'member-device-limit'));
  assert.deepEqual(definitions.filter((item) => item.scenario.includes('login-return')).map((item) => ({ alias: item.alias, role: item.role, twoFactorEnabled: item.twoFactorEnabled })), [
    { alias: 'member-login-return-a', role: 'member', twoFactorEnabled: false },
    { alias: 'member-login-return-b', role: 'member', twoFactorEnabled: false },
    { alias: 'member-login-return-c', role: 'member', twoFactorEnabled: false },
    { alias: 'member-login-return-d', role: 'member', twoFactorEnabled: false },
    { alias: 'member-login-return-e', role: 'member', twoFactorEnabled: false },
    { alias: 'staff-login-return-a', role: 'cs', twoFactorEnabled: false },
    { alias: 'staff-login-return-b', role: 'cs', twoFactorEnabled: false },
    { alias: 'staff-login-return-2fa', role: 'cs', twoFactorEnabled: true },
  ]);
  assert.deepEqual(definitions.filter((item) => item.scenario.startsWith('session-metadata-')).map((item) => item.alias), ['staff-session-a', 'staff-session-b', 'staff-session-c', 'staff-session-d']);
  assert.deepEqual(definitions.filter((item) => item.alias.startsWith('staff-disposition-')).map((item) => item.scenario), [
    'session-terminal-logout-desktop',
    'session-recoverable-network-desktop',
    'session-terminal-logout-mobile',
    'session-recoverable-network-mobile',
  ]);
  assert.deepEqual(definitions.filter((item) => item.alias.startsWith('staff-rotation-')).map((item) => item.scenario), [
    'refresh-rotation-desktop',
    'safe-get-replay-desktop',
    'refresh-rotation-mobile',
    'safe-get-replay-mobile',
  ]);
  assert.deepEqual(definitions.filter((item) => item.alias.startsWith('staff-response-loss-')).map((item) => item.scenario), [
    'refresh-response-loss-desktop',
    'refresh-response-loss-mobile',
  ]);
  assert.deepEqual(definitions.filter((item) => item.alias.startsWith('staff-multitab-')).map((item) => item.scenario), [
    'multitab-winner-desktop',
    'multitab-winner-mobile',
    'multitab-remote-logout-desktop',
    'multitab-remote-logout-mobile',
  ]);
  assert.deepEqual(definitions.filter((item) => item.alias.startsWith('staff-convergence-')).map((item) => item.scenario), [
    'ten-caller-convergence-desktop',
    'ten-caller-convergence-mobile',
  ]);
  assert.deepEqual(definitions.filter((item) => item.alias.startsWith('staff-refresh-race-')).map((item) => item.scenario), [
    'two-page-refresh-race-desktop',
    'two-page-refresh-race-mobile',
  ]);
  assert.deepEqual(definitions.filter((item) => item.alias.startsWith('staff-family-replay-')).map((item) => item.scenario), [
    'sequential-family-replay-desktop',
    'sequential-family-replay-mobile',
  ]);
  assert.deepEqual(definitions.filter((item) => item.alias.startsWith('staff-current-logout-')).map((item) => item.scenario), [
    'current-device-logout-desktop',
    'current-device-logout-mobile',
  ]);
  assert.deepEqual(definitions.filter((item) => item.alias.startsWith('staff-target-revoke-')).map((item) => item.scenario), [
    'target-device-revocation-desktop',
    'target-device-revocation-mobile',
  ]);
  assert.deepEqual(definitions.filter((item) => /^staff-(idle|expiry)-/.test(item.alias)).map((item) => item.scenario), [
    'staff-idle-lock-unlock-desktop',
    'staff-idle-lock-unlock-mobile',
    'staff-session-expiry-desktop',
    'staff-session-expiry-mobile',
  ]);
  assert.deepEqual(definitions.filter((item) => /^(staff|member)-replacement-/.test(item.alias)).map((item) => ({ scenario: item.scenario, role: item.role, twoFactorEnabled: item.twoFactorEnabled })), [
    { scenario: 'staff-device-replacement-desktop', role: 'cs', twoFactorEnabled: false },
    { scenario: 'staff-device-replacement-mobile', role: 'cs', twoFactorEnabled: false },
    { scenario: 'member-device-replacement-desktop', role: 'member', twoFactorEnabled: false },
    { scenario: 'member-device-replacement-mobile', role: 'member', twoFactorEnabled: false },
  ]);
  assert.deepEqual(definitions.filter((item) => item.alias.startsWith('staff-target-foreign-')).map((item) => ({ scenario: item.scenario, role: item.role, isolated: item.email !== definitions.find((candidate) => candidate.alias === `staff-target-revoke-${item.alias.endsWith('mobile') ? 'mobile' : 'desktop'}`)?.email })), [
    { scenario: 'target-device-foreign-desktop', role: 'cs', isolated: true },
    { scenario: 'target-device-foreign-mobile', role: 'cs', isolated: true },
  ]);
  assert.deepEqual(definitions.filter((item) => item.alias.startsWith('staff-logout-all-')).map((item) => item.scenario), [
    'all-device-logout-desktop',
    'all-device-logout-mobile',
  ]);
});

test('login returnTo subset contains only its required member and CS aliases', () => {
  const definitions = loginReturnToFixtureDefinitions('run-123', new Date('2026-07-18T00:00:00Z'));
  assert.deepEqual(definitions.map(({ alias, role }) => ({ alias, role })), [
    { alias: 'member-login-return-a', role: 'member' },
    { alias: 'member-login-return-b', role: 'member' },
    { alias: 'member-login-return-c', role: 'member' },
    { alias: 'member-login-return-d', role: 'member' },
    { alias: 'member-login-return-e', role: 'member' },
    { alias: 'staff-login-return-a', role: 'cs' },
    { alias: 'staff-login-return-b', role: 'cs' },
    { alias: 'staff-login-return-2fa', role: 'cs' },
  ]);
  assert.ok(definitions.every(({ scenario, role }) => scenario.includes('login-return') && (role === 'member' || role === 'cs')));
  assert.equal(definitions.some(({ alias, role }) => alias.startsWith('finance-') || role === 'admin'), false);
});

test('public fixture manifest contains no credentials or tokens', () => {
  const manifest = publicFixtureManifest(fixtureDefinitions('run-123', new Date('2026-07-18T00:00:00Z')));
  const serialized = JSON.stringify(manifest);
  assert.doesNotMatch(serialized, /password|token|secret|cookie|authorization/i);
  assert.ok(manifest.every((item) => item.alias && item.scenario && item.fixtureRunId));
});

test('seeder writes unique synthetic reference ids and bounded identifier-member balance', async () => {
  const source = await fs.readFile(path.resolve(import.meta.dirname, '..', 'seed.ts'), 'utf8');
  assert.match(source, /syntheticBalance \?\? /);
  assert.match(source, /referenceId: `TASK14-FIN-\$\{/);
  assert.match(source, /site-config-permission-manager[\s\S]*syntheticTotpSecret/);
  assert.doesNotMatch(source, /allow-protected-database/);
});
