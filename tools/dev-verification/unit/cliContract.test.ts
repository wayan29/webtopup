import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { resolvePublicCommand } from '../cliContract.ts';

test('public lifecycle commands map to one explicit operation', () => {
  assert.equal(resolvePublicCommand('setup'), 'setup');
  assert.equal(resolvePublicCommand('up'), 'up');
  assert.equal(resolvePublicCommand('seed'), 'seed');
  assert.equal(resolvePublicCommand('test'), 'test');
  assert.equal(resolvePublicCommand('login-return-to'), 'login-return-to');
  assert.equal(resolvePublicCommand('login-return-to-list'), 'login-return-to-list');
  assert.equal(resolvePublicCommand('public-routes'), 'public-routes');
  assert.equal(resolvePublicCommand('public-routes-list'), 'public-routes-list');
  assert.equal(resolvePublicCommand('reset'), 'reset');
  assert.equal(resolvePublicCommand('down'), 'down');
  assert.equal(resolvePublicCommand('purge'), 'purge');
  assert.equal(resolvePublicCommand('status'), 'status');
});

test('unknown or missing public command is rejected without fallback', () => {
  assert.equal(resolvePublicCommand(undefined), null);
  assert.equal(resolvePublicCommand('deploy'), null);
});

test('CLI rejects syntax before loading generated state and distinguishes operational failure', () => {
  const cli = path.resolve(import.meta.dirname, '..', 'cli.ts');
  const root = path.resolve(import.meta.dirname, '..', '..', '..');
  const run = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], { cwd: root, encoding: 'utf8' });
  assert.equal(run([]).status, 2);
  assert.equal(run(['deploy']).status, 2);
  assert.equal(run(['status', 'extra']).status, 2);
});
