import { spawn } from 'node:child_process';
import type { VerificationConfig } from './types.ts';
import { infrastructureDown, infrastructureUp } from './docker.ts';
import { startHostProcesses, stopHostProcesses } from './processes.ts';

const run = (root: string, args: readonly string[]): Promise<void> => new Promise((resolve, reject) => {
  const child = spawn('npx', [...args], { cwd: root, env: process.env, stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', (code, signal) => code === 0
    ? resolve()
    : reject(new Error(`public routes browser check failed with ${signal ? 'signal' : `exit ${code}`}`)));
});

const playwrightArgs = (list: boolean): string[] => [
  'playwright', 'test', '--config', 'tools/dev-verification/playwright.config.ts',
  'public-routes.spec.ts', '--project=chromium-desktop', '--project=chromium-mobile',
  '--workers=1', ...(list ? ['--list'] : []),
];

/**
 * Runs the canonical public-route suite using only checked-in configuration. The real run starts
 * the disposable HTTPS stack and current client source; API data stays synthetic via interception.
 */
export async function runPublicRoutesVerification(config: VerificationConfig): Promise<void> {
  const errors: unknown[] = [];
  try {
    await infrastructureUp(config);
    await startHostProcesses(config, 'disabled');
    await run(config.root, playwrightArgs(false));
  } catch (error) {
    errors.push(error);
  } finally {
    try { await stopHostProcesses(config); } catch (error) { errors.push(error); }
    try { await infrastructureDown(config, false); } catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'public routes verification and cleanup failed');
}

export async function listPublicRoutesTests(config: VerificationConfig): Promise<void> {
  await run(config.root, playwrightArgs(true));
}
