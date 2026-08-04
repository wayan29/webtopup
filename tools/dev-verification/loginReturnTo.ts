import { spawn } from 'node:child_process';
import path from 'node:path';
import type { VerificationConfig } from './types.ts';
import { infrastructureDown, infrastructureUp } from './docker.ts';
import { bootstrapFreshVerificationDatabase, resetMarkedVerificationDatabase } from './databaseWorkflow.ts';
import { seedLoginReturnToVerificationDatabase } from './seed.ts';
import { startHostProcesses, stopHostProcesses } from './processes.ts';

const run = (root: string, command: string, args: readonly string[]): Promise<void> => new Promise((resolve, reject) => {
  const child = spawn(command, [...args], { cwd: root, env: process.env, stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', (code, signal) => code === 0
    ? resolve()
    : reject(new Error(`login continuation browser check failed with ${signal ? 'signal' : `exit ${code}`}`)));
});

/**
 * Standalone Task 4 browser gate. It creates only the exact disposable stack, seeds synthetic
 * member/CS fixtures, runs the canonical desktop spec, and tears everything down on all exits.
 */
export async function runLoginReturnToVerification(config: VerificationConfig): Promise<void> {
  const errors: unknown[] = [];
  let markedDatabaseReady = false;
  try {
    // Bootstrap requires an inspected stack-owned Mongo volume before replacing it with a fresh
    // marked volume. Starting Compose here makes this command reproducible after setup alone.
    await infrastructureUp(config);
    await bootstrapFreshVerificationDatabase(config);
    markedDatabaseReady = true;
    // A prior interrupted or failed run can leave the manifest beside a freshly recreated marked
    // database. Reset before seeding so fixture aliases and credential state are always unique.
    await resetMarkedVerificationDatabase(config);
    await seedLoginReturnToVerificationDatabase(config);
    await startHostProcesses(config, 'session-device-policy');
    await run(config.root, 'npx', [
      'playwright', 'test', '--config', 'tools/dev-verification/playwright.config.ts',
      'login-return-to.spec.ts', '--project=chromium-desktop', '--workers=1',
    ]);
  } catch (error) {
    errors.push(error);
  } finally {
    try { await stopHostProcesses(config); } catch (error) { errors.push(error); }
    if (markedDatabaseReady) {
      try { await resetMarkedVerificationDatabase(config); } catch (error) { errors.push(error); }
    }
    try { await infrastructureDown(config, false); } catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'login continuation verification and cleanup failed');
}

export async function listLoginReturnToTests(config: VerificationConfig): Promise<void> {
  await run(config.root, 'npx', [
    'playwright', 'test', '--config', path.join('tools', 'dev-verification', 'playwright.config.ts'),
    'login-return-to.spec.ts', '--project=chromium-desktop', '--workers=1', '--list',
  ]);
}
