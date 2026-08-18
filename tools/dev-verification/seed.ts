import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import mongoose from '../../server/node_modules/mongoose/index.js';
import User from '../../server/src/models/User.ts';
import type { VerificationConfig } from './types.ts';
import { MARKER_COLLECTION } from './database.ts';
import { assertMarkedVerificationDatabaseReady } from './databaseWorkflow.ts';

export type FixtureDefinition = {
  alias: string;
  scenario: string;
  email: string;
  role: 'member' | 'cs' | 'admin' | 'owner';
  task14Fixture: true;
  fixtureRunId: string;
  active: boolean;
  permissions?: Record<string, boolean>;
  twoFactorEnabled: boolean;
  twoFactorEnrollmentRequiredAt?: Date;
  activeDeviceCount: number;
  syntheticBalance?: number;
};

export type PublicFixture = Pick<FixtureDefinition, 'alias' | 'scenario' | 'fixtureRunId' | 'role'>;

export function fixtureDefinitions(fixtureRunId: string, now = new Date()): FixtureDefinition[] {
  const future = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const past = new Date(now.getTime() - 60 * 1000);
  const make = (alias: string, scenario: string, role: FixtureDefinition['role'], extra: Partial<FixtureDefinition> = {}): FixtureDefinition => ({
    alias, scenario, role, email: `${alias}.${fixtureRunId}@task14.invalid`, task14Fixture: true, fixtureRunId, active: true,
    twoFactorEnabled: role === 'member', activeDeviceCount: 0, ...extra,
  });
  return [
    make('member-remembered', 'member-remembered', 'member'),
    make('member-standard', 'member-non-remembered', 'member'),
    make('member-device-limit', 'member-device-limit', 'member', { activeDeviceCount: 5 }),
    make('staff-grace-desktop', 'staff-2fa-grace-desktop', 'cs', { twoFactorEnabled: false, twoFactorEnrollmentRequiredAt: future }),
    make('staff-grace-mobile', 'staff-2fa-grace-mobile', 'cs', { twoFactorEnabled: false, twoFactorEnrollmentRequiredAt: future }),
    make('staff-session-a', 'session-metadata-standard', 'cs', { twoFactorEnabled: false, twoFactorEnrollmentRequiredAt: future }),
    make('staff-session-b', 'session-metadata-remembered-input', 'cs', { twoFactorEnabled: false, twoFactorEnrollmentRequiredAt: future }),
    make('staff-session-c', 'session-metadata-mobile-standard', 'cs', { twoFactorEnabled: false, twoFactorEnrollmentRequiredAt: future }),
    make('staff-session-d', 'session-metadata-mobile-remembered-input', 'cs', { twoFactorEnabled: false, twoFactorEnrollmentRequiredAt: future }),
    make('staff-disposition-terminal-desktop', 'session-terminal-logout-desktop', 'cs', { twoFactorEnabled: false, twoFactorEnrollmentRequiredAt: future }),
    make('staff-disposition-recoverable-desktop', 'session-recoverable-network-desktop', 'cs', { twoFactorEnabled: false, twoFactorEnrollmentRequiredAt: future }),
    make('staff-disposition-terminal-mobile', 'session-terminal-logout-mobile', 'cs', { twoFactorEnabled: false, twoFactorEnrollmentRequiredAt: future }),
    make('staff-disposition-recoverable-mobile', 'session-recoverable-network-mobile', 'cs', { twoFactorEnabled: false, twoFactorEnrollmentRequiredAt: future }),
    make('staff-rotation-desktop', 'refresh-rotation-desktop', 'cs', { twoFactorEnabled: false, twoFactorEnrollmentRequiredAt: future }),
    make('staff-rotation-get-desktop', 'safe-get-replay-desktop', 'cs', { twoFactorEnabled: false, twoFactorEnrollmentRequiredAt: future }),
    make('staff-rotation-mobile', 'refresh-rotation-mobile', 'cs', { twoFactorEnabled: false, twoFactorEnrollmentRequiredAt: future }),
    make('staff-rotation-get-mobile', 'safe-get-replay-mobile', 'cs', { twoFactorEnabled: false, twoFactorEnrollmentRequiredAt: future }),
    make('staff-response-loss-desktop', 'refresh-response-loss-desktop', 'cs', { twoFactorEnabled: false, twoFactorEnrollmentRequiredAt: future }),
    make('staff-response-loss-mobile', 'refresh-response-loss-mobile', 'cs', { twoFactorEnabled: false, twoFactorEnrollmentRequiredAt: future }),
    make('staff-multitab-desktop', 'multitab-winner-desktop', 'cs', { twoFactorEnabled: false, twoFactorEnrollmentRequiredAt: future }),
    make('staff-multitab-mobile', 'multitab-winner-mobile', 'cs', { twoFactorEnabled: false, twoFactorEnrollmentRequiredAt: future }),
    make('staff-multitab-logout-desktop', 'multitab-remote-logout-desktop', 'cs', { twoFactorEnabled: false, twoFactorEnrollmentRequiredAt: future }),
    make('staff-multitab-logout-mobile', 'multitab-remote-logout-mobile', 'cs', { twoFactorEnabled: false, twoFactorEnrollmentRequiredAt: future }),
    make('staff-convergence-desktop', 'ten-caller-convergence-desktop', 'cs', { twoFactorEnabled: false, twoFactorEnrollmentRequiredAt: future }),
    make('staff-convergence-mobile', 'ten-caller-convergence-mobile', 'cs', { twoFactorEnabled: false, twoFactorEnrollmentRequiredAt: future }),
    make('staff-refresh-race-desktop', 'two-page-refresh-race-desktop', 'cs', { twoFactorEnabled: false, twoFactorEnrollmentRequiredAt: future }),
    make('staff-refresh-race-mobile', 'two-page-refresh-race-mobile', 'cs', { twoFactorEnabled: false, twoFactorEnrollmentRequiredAt: future }),
    make('staff-family-replay-desktop', 'sequential-family-replay-desktop', 'cs', { twoFactorEnabled: false, twoFactorEnrollmentRequiredAt: future }),
    make('staff-family-replay-mobile', 'sequential-family-replay-mobile', 'cs', { twoFactorEnabled: false, twoFactorEnrollmentRequiredAt: future }),
    make('staff-current-logout-desktop', 'current-device-logout-desktop', 'cs', { twoFactorEnabled: false, twoFactorEnrollmentRequiredAt: future }),
    make('staff-current-logout-mobile', 'current-device-logout-mobile', 'cs', { twoFactorEnabled: false, twoFactorEnrollmentRequiredAt: future }),
    make('staff-target-revoke-desktop', 'target-device-revocation-desktop', 'cs', { twoFactorEnabled: false, twoFactorEnrollmentRequiredAt: future }),
    make('staff-target-revoke-mobile', 'target-device-revocation-mobile', 'cs', { twoFactorEnabled: false, twoFactorEnrollmentRequiredAt: future }),
    make('staff-target-foreign-desktop', 'target-device-foreign-desktop', 'cs', { twoFactorEnabled: false, twoFactorEnrollmentRequiredAt: future }),
    make('staff-target-foreign-mobile', 'target-device-foreign-mobile', 'cs', { twoFactorEnabled: false, twoFactorEnrollmentRequiredAt: future }),
    make('staff-idle-desktop', 'staff-idle-lock-unlock-desktop', 'cs', { twoFactorEnabled: false, twoFactorEnrollmentRequiredAt: future }),
    make('staff-idle-mobile', 'staff-idle-lock-unlock-mobile', 'cs', { twoFactorEnabled: false, twoFactorEnrollmentRequiredAt: future }),
    make('staff-expiry-desktop', 'staff-session-expiry-desktop', 'cs', { twoFactorEnabled: false, twoFactorEnrollmentRequiredAt: future }),
    make('staff-expiry-mobile', 'staff-session-expiry-mobile', 'cs', { twoFactorEnabled: false, twoFactorEnrollmentRequiredAt: future }),
    make('staff-overdue-desktop', 'staff-overdue-2fa', 'cs', { twoFactorEnabled: false, twoFactorEnrollmentRequiredAt: past }),
    make('staff-overdue-mobile', 'staff-overdue-2fa-mobile', 'cs', { twoFactorEnabled: false, twoFactorEnrollmentRequiredAt: past }),
    make('member-enrollment-desktop', 'member-enrollment-unaffected-desktop', 'member', { twoFactorEnabled: false }),
    make('member-enrollment-mobile', 'member-enrollment-unaffected-mobile', 'member', { twoFactorEnabled: false }),
    make('member-login-return-a', 'member-login-return-a', 'member', { twoFactorEnabled: false }),
    make('member-login-return-b', 'member-login-return-b', 'member', { twoFactorEnabled: false }),
    make('member-login-return-c', 'member-login-return-c', 'member', { twoFactorEnabled: false }),
    make('member-login-return-d', 'member-login-return-d', 'member', { twoFactorEnabled: false }),
    make('member-login-return-e', 'member-login-return-e', 'member', { twoFactorEnabled: false }),
    make('staff-login-return-a', 'staff-login-return-a', 'cs', { twoFactorEnabled: false, twoFactorEnrollmentRequiredAt: future }),
    make('staff-login-return-b', 'staff-login-return-b', 'cs', { twoFactorEnabled: false, twoFactorEnrollmentRequiredAt: future }),
    make('staff-login-return-2fa', 'staff-login-return-2fa', 'cs', { twoFactorEnabled: true }),
    make('staff-device-limit', 'staff-device-limit', 'cs', { activeDeviceCount: 2, twoFactorEnabled: true }),
    make('staff-replacement-desktop', 'staff-device-replacement-desktop', 'cs', { twoFactorEnabled: false, twoFactorEnrollmentRequiredAt: future }),
    make('staff-replacement-mobile', 'staff-device-replacement-mobile', 'cs', { twoFactorEnabled: false, twoFactorEnrollmentRequiredAt: future }),
    make('member-replacement-desktop', 'member-device-replacement-desktop', 'member', { twoFactorEnabled: false }),
    make('member-replacement-mobile', 'member-device-replacement-mobile', 'member', { twoFactorEnabled: false }),
    make('staff-step-up-desktop', 'staff-step-up-desktop', 'cs', { twoFactorEnabled: true }),
    make('staff-step-up-mobile', 'staff-step-up-mobile', 'cs', { twoFactorEnabled: true }),
    make('staff-logout-all-desktop', 'all-device-logout-desktop', 'cs', { twoFactorEnabled: true }),
    make('staff-logout-all-mobile', 'all-device-logout-mobile', 'cs', { twoFactorEnabled: true }),
    make('refresh-compromised', 'refresh-family-replay', 'member'),
    make('refresh-healthy', 'refresh-family-isolation', 'member'),
    make('finance-actor', 'finance-idempotency', 'admin', { twoFactorEnabled: true }),
    make('finance-target', 'finance-idempotency-target', 'member', { twoFactorEnabled: false }),
    make('team-access-viewer-desktop', 'team-access-review-desktop', 'cs', {
      twoFactorEnabled: false,
      twoFactorEnrollmentRequiredAt: future,
      permissions: { viewDashboard: true, viewTeam: true },
    }),
    make('team-access-viewer-mobile', 'team-access-review-mobile', 'cs', {
      twoFactorEnabled: false,
      twoFactorEnrollmentRequiredAt: future,
      permissions: { viewDashboard: true, viewTeam: true },
    }),
    make('team-access-owner-target', 'team-access-owner-target', 'owner', {
      twoFactorEnabled: false,
      twoFactorEnrollmentRequiredAt: future,
      permissions: {},
    }),
    make('team-access-suspended-target', 'team-access-suspended-target', 'cs', {
      active: false,
      twoFactorEnabled: false,
      twoFactorEnrollmentRequiredAt: future,
      permissions: { viewDashboard: true, viewTeam: true },
    }),
    make('catalog-viewer', 'catalog-permission-viewer', 'cs', {
      twoFactorEnabled: false,
      twoFactorEnrollmentRequiredAt: future,
      permissions: { viewProducts: true, manageProducts: false },
    }),
    make('catalog-manager', 'catalog-permission-manager', 'cs', {
      twoFactorEnabled: false,
      twoFactorEnrollmentRequiredAt: future,
      permissions: { viewProducts: false, manageProducts: true },
    }),
    make('audit-denied', 'audit-permission-denied', 'cs', {
      twoFactorEnabled: false,
      twoFactorEnrollmentRequiredAt: future,
      permissions: { viewDashboard: true, viewTeam: false, manageTeam: false },
    }),
    // Use CS rather than admin: disposable admin 2FA issuance currently returns 503 while
// CS step-up fixtures remain healthy, and manageTeam is sufficient for audit export.
    make('audit-manager', 'audit-permission-manager', 'cs', {
      twoFactorEnabled: true,
      permissions: {
        viewDashboard: true,
        viewTeam: true,
        manageTeam: true,
        viewProducts: true,
        manageProducts: true,
      },
    }),
    make('vendor-health-denied', 'vendor-health-permission-denied', 'cs', {
      twoFactorEnabled: false,
      twoFactorEnrollmentRequiredAt: future,
      permissions: { viewDashboard: true },
    }),
    make('vendor-health-manager', 'vendor-health-permission-manager', 'cs', {
      twoFactorEnabled: true,
      permissions: {
        viewDashboard: true,
        manageVendors: true,
      },
    }),
    make('site-config-denied', 'site-config-permission-denied', 'cs', {
      twoFactorEnabled: false,
      twoFactorEnrollmentRequiredAt: future,
      permissions: { viewDashboard: true, manageSettings: false, viewProducts: true },
    }),
    make('site-config-manager', 'site-config-permission-manager', 'cs', {
      twoFactorEnabled: true,
      permissions: {
        viewDashboard: true,
        manageSettings: true,
        manageProducts: true,
        viewProducts: true,
      },
    }),
    make('site-config-inactive', 'site-config-permission-inactive', 'cs', {
      active: false,
      twoFactorEnabled: true,
      permissions: { viewDashboard: true, manageSettings: true },
    }),
    make('slider-denied', 'slider-permission-denied', 'cs', {
      twoFactorEnabled: false,
      permissions: { viewDashboard: true, manageSettings: false },
    }),
    make('slider-manager', 'slider-permission-manager', 'cs', {
      twoFactorEnabled: true,
      permissions: { viewDashboard: true, manageSettings: true },
    }),
    make('slider-inactive', 'slider-permission-inactive', 'cs', {
      active: false,
      twoFactorEnabled: true,
      permissions: { viewDashboard: true, manageSettings: true },
    }),
    make('identifier-member', 'identifier-integrity-member', 'member', {
      twoFactorEnabled: false,
      syntheticBalance: 100_000,
    }),
  ];
}

const LOGIN_RETURN_TO_ALIASES = new Set([
  'member-login-return-a',
  'member-login-return-b',
  'member-login-return-c',
  'member-login-return-d',
  'member-login-return-e',
  'staff-login-return-a',
  'staff-login-return-b',
  'staff-login-return-2fa',
]);

/** Exact Task 4 browser fixtures: no admin actor and no finance target or transaction. */
export function loginReturnToFixtureDefinitions(fixtureRunId: string, now = new Date()): FixtureDefinition[] {
  const definitions = fixtureDefinitions(fixtureRunId, now).filter(({ alias }) => LOGIN_RETURN_TO_ALIASES.has(alias));
  if (definitions.length !== LOGIN_RETURN_TO_ALIASES.size
    || definitions.some(({ role }) => role !== 'member' && role !== 'cs')) {
    throw new Error('login returnTo fixture subset is incomplete or has a forbidden role');
  }
  return definitions;
}

export function publicFixtureManifest(fixtures: readonly FixtureDefinition[]): PublicFixture[] {
  return fixtures.map(({ alias, scenario, fixtureRunId, role }) => ({ alias, scenario, fixtureRunId, role }));
}

export const newFixtureRunId = (): string => crypto.randomUUID();
const syntheticTotpSecret = (): string => Array.from(crypto.randomBytes(32), (byte) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[byte % 32]).join('');

const privateEnv = async (config: VerificationConfig): Promise<Record<string, string>> => Object.fromEntries(
  (await fs.readFile(path.join(config.stateDir, 'env', 'node.env'), 'utf8')).split(/\r?\n/u).filter(Boolean).map((line) => {
    const index = line.indexOf('=');
    if (index < 1) throw new Error('invalid private fixture environment');
    return [line.slice(0, index), line.slice(index + 1)];
  }),
);

async function seedFixtureDefinitions(
  config: VerificationConfig,
  definitions: readonly FixtureDefinition[],
  includeFinanceTransaction: boolean,
): Promise<PublicFixture[]> {
  await assertMarkedVerificationDatabaseReady(config);
  const secrets = await privateEnv(config);
  const passwords: Record<FixtureDefinition['role'], string | undefined> = {
    member: secrets.FIXTURE_MEMBER_PASSWORD,
    cs: secrets.FIXTURE_STAFF_PASSWORD,
    admin: secrets.FIXTURE_ADMIN_PASSWORD,
    owner: secrets.FIXTURE_ADMIN_PASSWORD,
  };
  const requiredRoles = new Set(definitions.map(({ role }) => role));
  if ([...requiredRoles].some((role) => !passwords[role] || passwords[role]!.length < 12)) throw new Error('fixture passwords are unavailable');
  await mongoose.connect(config.mongoUri, { dbName: config.databaseName });
  try {
    const markerCount = await mongoose.connection.db!.collection(MARKER_COLLECTION).countDocuments({ kind: 'webtopup-local-dev-verification' });
    if (markerCount !== 1) throw new Error('verification marker is missing or ambiguous');
    await User.createIndexes();
    const manifest: PublicFixture[] = [];
    let financeTargetId: mongoose.Types.ObjectId | null = null;
    for (const fixture of definitions) {
      const user = new User({
        email: fixture.email, password: passwords[fixture.role], name: `Task 14 ${fixture.alias}`,
        role: fixture.role, level: 'basic', balance: fixture.syntheticBalance ?? (fixture.scenario === 'finance-idempotency' ? 100_000 : 0),
        permissions: {
          ...(fixture.permissions ?? {}),
          ...(fixture.scenario === 'finance-idempotency' ? { manageUsers: true, processManualTransaction: true } : {}),
          ...(fixture.scenario.startsWith('staff-login-return') ? { manageVendors: true } : {}),
        },
        points: 0, twoFactorEnabled: fixture.twoFactorEnabled, twoFactorEnrollmentRequiredAt: fixture.twoFactorEnrollmentRequiredAt,
        twoFactorSecret: fixture.twoFactorEnabled && (fixture.role === 'admin' || fixture.scenario.startsWith('all-device-logout-') || fixture.scenario.startsWith('staff-step-up-') || fixture.scenario === 'staff-login-return-2fa' || fixture.scenario === 'audit-permission-manager' || fixture.scenario === 'site-config-permission-manager' || fixture.scenario === 'site-config-permission-inactive' || fixture.scenario === 'slider-permission-manager' || fixture.scenario === 'slider-permission-inactive' || fixture.scenario === 'slider-permission-denied' || fixture.scenario === 'vendor-health-permission-manager') ? syntheticTotpSecret() : undefined,
        twoFactorEnrollmentCompletedAt: fixture.twoFactorEnabled && (fixture.role === 'admin' || fixture.scenario.startsWith('all-device-logout-') || fixture.scenario === 'slider-permission-manager' || fixture.scenario === 'slider-permission-inactive') ? new Date() : undefined,
        sessionVersion: 0, active: fixture.active,
      });
      await user.save();
      await User.collection.updateOne({ _id: user._id }, { $set: {
        task14Fixture: true, fixtureRunId: fixture.fixtureRunId, fixtureScenario: fixture.scenario,
        intendedActiveDeviceCount: fixture.activeDeviceCount,
      } });
      if (fixture.scenario === 'finance-idempotency-target') financeTargetId = user._id;
      manifest.push({ alias: fixture.alias, scenario: fixture.scenario, fixtureRunId: fixture.fixtureRunId, role: fixture.role });
    }
    if (includeFinanceTransaction) {
      if (!financeTargetId) throw new Error('finance target fixture is unavailable');
      await mongoose.connection.db!.collection('transactions').insertOne({
        user: financeTargetId, product: new mongoose.Types.ObjectId(), target: 'synthetic-task14-target', amount: 12_500,
        status: 'failed', refunded: false, source: 'web', referenceId: `TASK14-FIN-${definitions[0]!.fixtureRunId}`,
        task14Fixture: true, fixtureRunId: definitions[0]!.fixtureRunId,
        fixtureScenario: 'finance-idempotency-refund', createdAt: new Date(), updatedAt: new Date(),
      });
    }
    const manifestPath = path.join(config.stateDir, 'fixture-manifest.json');
    await fs.writeFile(`${manifestPath}.tmp`, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    await fs.rename(`${manifestPath}.tmp`, manifestPath);
    return manifest;
  } finally { await mongoose.disconnect(); }
}

export async function seedVerificationDatabase(config: VerificationConfig): Promise<PublicFixture[]> {
  const fixtureRunId = newFixtureRunId();
  return seedFixtureDefinitions(config, fixtureDefinitions(fixtureRunId), true);
}

/** Seed only the eight member/CS aliases consumed by the canonical Task 4 browser spec. */
export async function seedLoginReturnToVerificationDatabase(config: VerificationConfig): Promise<PublicFixture[]> {
  const fixtureRunId = newFixtureRunId();
  return seedFixtureDefinitions(config, loginReturnToFixtureDefinitions(fixtureRunId), false);
}
