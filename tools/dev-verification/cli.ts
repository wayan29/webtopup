#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { generateLocalState } from './generate.ts';
import { loadVerificationConfig } from './config.ts';
import { infrastructureDown, infrastructureStatus, infrastructureUp } from './docker.ts';
import { startHostProcesses, stopHostProcesses } from './processes.ts';
import { bootstrapFreshVerificationDatabase, resetMarkedVerificationDatabase } from './databaseWorkflow.ts';
import { seedVerificationDatabase } from './seed.ts';
import { collectStatus } from './status.ts';
import { redact, writeEvidenceAtomic } from './redact.ts';
import { resolvePublicCommand } from './cliContract.ts';
import { runFullVerification } from './verify.ts';
import { auditRetainedReports } from './audit.ts';
import { listLoginReturnToTests, runLoginReturnToVerification } from './loginReturnTo.ts';
import { listPublicRoutesTests, runPublicRoutesVerification } from './publicRoutes.ts';

const root = path.resolve(import.meta.dirname, '..', '..');
const command = process.argv[2];

async function main(): Promise<void> {
  const internalCommands = new Set(['infra-up', 'infra-down', 'infra-status', 'host-up', 'host-up-session', 'host-up-session-fault', 'host-up-session-device-policy', 'host-up-session-finance-policy', 'host-up-session-finance-fault', 'host-up-session-rollout-pre-cutoff', 'host-up-session-rollout-post-cutoff', 'host-down', 'db-bootstrap', 'db-reset', 'db-seed', 'audit-reports']);
  const publicCommand = resolvePublicCommand(command);
  if (!publicCommand && !internalCommands.has(command ?? '')) { console.error('Usage: npm run dev-verify -- setup|up|seed|test|login-return-to|login-return-to-list|public-routes|public-routes-list|reset|down|purge|status'); process.exitCode = 2; return; }
  if (publicCommand && process.argv.length !== 3) { console.error(`${publicCommand} accepts no target arguments`); process.exitCode = 2; return; }
  if (command === 'setup') {
    await generateLocalState(root);
    loadVerificationConfig(root);
    console.log('Local verification state initialized without printing secrets.');
    return;
  }
  const config = loadVerificationConfig(root);
  if (command === 'up') {
    try { await infrastructureUp(config); await startHostProcesses(config, 'disabled'); }
    catch (primary) { try { await stopHostProcesses(config); await infrastructureDown(config, false); } catch (cleanup) { throw new AggregateError([primary, cleanup], 'up and rollback failed'); } throw primary; }
    console.log('Local verification stack is healthy with rollout disabled.'); return;
  }
  if (command === 'seed') { const manifest = await seedVerificationDatabase(config); console.log(`Created ${manifest.length} synthetic fixture aliases without printing credentials.`); return; }
  if (command === 'reset') { await resetMarkedVerificationDatabase(config); console.log('Marked disposable verification database reset.'); return; }
  if (command === 'down' || command === 'purge') {
    const errors: unknown[] = [];
    try { await stopHostProcesses(config); } catch (error) { errors.push(error); }
    try { await infrastructureDown(config, command === 'purge'); } catch (error) { errors.push(error); }
    if (errors.length === 1) throw errors[0]; if (errors.length > 1) throw new AggregateError(errors, 'stack shutdown failed');
    console.log(command === 'purge' ? 'Local verification stack and disposable volume purged.' : 'Local verification stack stopped.'); return;
  }
  if (command === 'test') {
    const result = await runFullVerification(config);
    console.log(result);
    if (result !== 'LOCAL DEV VERIFIED') process.exitCode = 1;
    return;
  }
  if (command === 'login-return-to-list') {
    await listLoginReturnToTests(config);
    return;
  }
  if (command === 'login-return-to') {
    await runLoginReturnToVerification(config);
    console.log('LOCAL DEV VERIFIED');
    return;
  }
  if (command === 'public-routes-list') {
    await listPublicRoutesTests(config);
    return;
  }
  if (command === 'public-routes') {
    await runPublicRoutesVerification(config);
    console.log('LOCAL DEV VERIFIED');
    return;
  }
  if (command === 'audit-reports') { await auditRetainedReports(config); console.log('Retained report secrecy audit passed.'); return; }
  if (command === 'infra-up') {
    await infrastructureUp(config);
    console.log('Local verification infrastructure is healthy.');
    return;
  }
  if (command === 'infra-down') {
    await infrastructureDown(config, process.argv.includes('--purge'));
    console.log('Local verification infrastructure stopped.');
    return;
  }
  if (command === 'infra-status') {
    const status = await infrastructureStatus(config);
    console.log(JSON.stringify({ serviceCount: status.services.length }));
    return;
  }
  if (command === 'status') {
    if (process.argv.length !== 3) throw new Error('status accepts no target arguments');
    const status = await collectStatus(config);
    const reportPath = path.join(config.stateDir, 'reports', 'status.json');
    const writeResult = await writeEvidenceAtomic(reportPath, status);
    if (writeResult === 'LOCAL DEV FAILED') {
      console.log(JSON.stringify({ result: 'LOCAL DEV FAILED' }));
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(redact(status)));
    return;
  }
  if (command === 'host-up' || command === 'host-up-session' || command === 'host-up-session-fault' || command === 'host-up-session-device-policy' || command === 'host-up-session-finance-policy' || command === 'host-up-session-finance-fault' || command === 'host-up-session-rollout-pre-cutoff' || command === 'host-up-session-rollout-post-cutoff') {
    if (process.argv.length !== 3) throw new Error(`${command} accepts no target arguments`);
    await startHostProcesses(config, command === 'host-up-session-fault' ? 'session-cs-fault' : command === 'host-up-session-rollout-pre-cutoff' ? 'session-rollout-pre-cutoff' : command === 'host-up-session-rollout-post-cutoff' ? 'session-rollout-post-cutoff' : command === 'host-up-session-finance-fault' ? 'session-finance-fault' : command === 'host-up-session-finance-policy' ? 'session-finance-policy' : command === 'host-up-session-device-policy' ? 'session-device-policy' : command === 'host-up-session' ? 'session-cs' : 'disabled');
    console.log('Local verification host processes are healthy.');
    return;
  }
  if (command === 'host-down') {
    await stopHostProcesses(config);
    console.log('Local verification host processes stopped.');
    return;
  }
  if (command === 'db-bootstrap') {
    if (process.argv.length !== 3) throw new Error('db-bootstrap accepts no target arguments');
    await bootstrapFreshVerificationDatabase(config);
    console.log('Fresh disposable verification database initialized.');
    return;
  }
  if (command === 'db-reset') {
    if (process.argv.length !== 3) throw new Error('db-reset accepts no target arguments');
    await resetMarkedVerificationDatabase(config);
    console.log('Marked disposable verification database reset.');
    return;
  }
  if (command === 'db-seed') {
    if (process.argv.length !== 3) throw new Error('db-seed accepts no target arguments');
    const manifest = await seedVerificationDatabase(config);
    console.log(`Created ${manifest.length} synthetic fixture aliases without printing credentials.`);
    return;
  }
  console.error('Usage: npm run dev-verify -- setup|up|seed|test|login-return-to|login-return-to-list|public-routes|public-routes-list|reset|down|purge|status');
  process.exitCode = 2;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'local verification command failed');
  process.exitCode = 1;
});
