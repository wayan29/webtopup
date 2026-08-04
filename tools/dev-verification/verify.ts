import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { VerificationConfig, VerificationResultStatus } from './types.ts';
import { resetMarkedVerificationDatabase } from './databaseWorkflow.ts';
import { seedVerificationDatabase } from './seed.ts';
import { startHostProcesses, stopHostProcesses, type ProcessProfile } from './processes.ts';
import { collectStatus } from './status.ts';
import { writeEvidenceAtomic } from './redact.ts';
import { verificationMatrix } from './verificationMatrix.ts';
import type { MatrixCheck, MatrixProfile } from './verificationMatrix.ts';

export type VerificationCheck = {
  name: string;
  required: boolean;
  result: VerificationResultStatus;
  phase?: 'prepare' | 'start' | 'run' | 'stop' | 'verify-stopped';
};

export type VerificationStep = Omit<VerificationCheck, 'result'> & {
  run: () => Promise<VerificationResultStatus>;
};

export type MatrixExecutorDependencies = {
  prepareDatabase: () => Promise<void>;
  resetDatabase: () => Promise<void>;
  startProfile: (profile: Exclude<MatrixProfile, 'none' | 'self-managed' | 'stopped'>) => Promise<void>;
  stopHost: () => Promise<void>;
  runCommand: (command: string, args: readonly string[], checkName: string) => Promise<void>;
  verifyStopped: () => Promise<void>;
};

export async function executeVerificationMatrix(matrix: readonly MatrixCheck[], deps: MatrixExecutorDependencies): Promise<VerificationCheck[]> {
  const checks: VerificationCheck[] = [];
  let active: MatrixProfile = 'none';
  for (const item of matrix) {
    let phase: VerificationCheck['phase'] = 'run';
    let primary: unknown;
    try {
      if (item.profile === 'stopped') {
        phase = 'stop';
        if (active !== 'none') { await deps.stopHost(); active = 'none'; }
        phase = 'verify-stopped'; await deps.verifyStopped();
      } else if (item.profile === 'self-managed') {
        if (active !== 'none') { await deps.stopHost(); active = 'none'; }
        phase = 'run'; await deps.runCommand(item.command, item.args, item.name);
      } else {
        if (item.profile !== 'none' && (item.profile !== active || item.isolated)) {
          if (active !== 'none') { phase = 'stop'; await deps.stopHost(); active = 'none'; }
          phase = 'prepare'; await deps.prepareDatabase();
          phase = 'start'; await deps.startProfile(item.profile);
          active = item.profile;
        }
        phase = 'run'; await deps.runCommand(item.command, item.args, item.name);
      }
    } catch (error) {
      primary = error;
    } finally {
      if (item.isolated && item.profile !== 'self-managed' && item.profile !== 'stopped') {
        try {
          if (active !== 'none') { await deps.stopHost(); active = 'none'; }
          await deps.resetDatabase();
        } catch (error) {
          primary = primary ? new AggregateError([primary, error], `isolated check ${item.name} and cleanup failed`) : error;
        }
      }
    }
    checks.push({ name: item.name, required: item.required, result: primary ? 'LOCAL DEV FAILED' : 'LOCAL DEV VERIFIED', ...(primary ? { phase } : {}) });
    if (primary) break;
  }
  return checks;
}

export function aggregateVerdict(checks: readonly VerificationCheck[]): VerificationResultStatus {
  return checks.every((check) => !check.required || check.result === 'LOCAL DEV VERIFIED')
    ? 'LOCAL DEV VERIFIED'
    : 'LOCAL DEV FAILED';
}

async function runLogged(config: VerificationConfig, command: string, args: readonly string[], checkName: string): Promise<void> {
  const logDir = path.join(config.stateDir, 'logs', 'checks');
  await fs.mkdir(logDir, { recursive: true, mode: 0o700 });
  const logPath = path.join(logDir, `${checkName}.log`);
  const handle = await fs.open(logPath, 'w', 0o600);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, [...args], { cwd: config.root, env: process.env, stdio: ['ignore', handle.fd, handle.fd] });
      child.once('error', reject);
      child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`check ${checkName} failed with ${signal ? 'signal' : 'exit'} status`)));
    });
  } finally { await handle.close(); }
}

const processProfile = (profile: 'disabled' | 'session-cs' | 'session-cs-fault' | 'session-device-policy' | 'session-finance-fault'): ProcessProfile => profile;

export async function beginVerificationReport(reportPath: string): Promise<{ runId: string; startedAt: string }> {
  const run = { runId: crypto.randomUUID(), startedAt: new Date().toISOString() };
  const result = await writeEvidenceAtomic(reportPath, { result: 'NOT RUN', ...run, checks: [] });
  if (result !== 'LOCAL DEV VERIFIED') throw new Error('could not initialize aggregate verification report');
  return run;
}

export async function runFullVerification(config: VerificationConfig): Promise<VerificationResultStatus> {
  const reportPath = path.join(config.stateDir, 'reports', 'aggregate.json');
  const run = await beginVerificationReport(reportPath);
  const matrix = verificationMatrix();
  const checks: VerificationCheck[] = [];
  let cleanupFailed = false;
  try {
    await stopHostProcesses(config);
    checks.push(...await executeVerificationMatrix(matrix, {
      prepareDatabase: async () => { await resetMarkedVerificationDatabase(config); await seedVerificationDatabase(config); },
      resetDatabase: async () => { await resetMarkedVerificationDatabase(config); },
      startProfile: async (profile) => { await startHostProcesses(config, processProfile(profile)); },
      stopHost: async () => { await stopHostProcesses(config); },
      runCommand: async (command, args, name) => runLogged(config, command, args, name),
      verifyStopped: async () => {
        const status = await collectStatus(config);
        if (status.processes.length !== 0 || status.rollout.enabled || Object.values(status.rollout).some((value) => typeof value === 'number' && value !== 0)) throw new Error('stopped-state verification failed');
      },
    }));
  } catch {
    cleanupFailed = true;
  } finally {
    try { await stopHostProcesses(config); } catch { cleanupFailed = true; }
  }
  if (cleanupFailed) checks.push({ name: 'cleanup', required: true, result: 'LOCAL DEV FAILED' });
  const requiredNames = matrix.filter(({ required }) => required).map(({ name }) => name);
  const completedNames = new Set(checks.map(({ name }) => name));
  for (const name of requiredNames) if (!completedNames.has(name)) checks.push({ name, required: true, result: 'NOT RUN' });
  const result = aggregateVerdict(checks);
  const status = await collectStatus(config);
  const report = { result, ...run, completedAt: new Date().toISOString(), checks, source: { commit: status.commit, trackedDirty: status.trackedDirty }, providerMode: status.providerMode, rollout: status.rollout };
  const writeResult = await writeEvidenceAtomic(reportPath, report);
  return writeResult === 'LOCAL DEV VERIFIED' ? result : 'LOCAL DEV FAILED';
}

export async function runVerificationSteps(
  steps: readonly VerificationStep[],
  cleanup: () => Promise<void>,
): Promise<VerificationCheck[]> {
  const checks: VerificationCheck[] = [];
  let primary: unknown;
  try {
    for (const step of steps) {
      const result = await step.run();
      checks.push({ name: step.name, required: step.required, result });
      if (step.required && result !== 'LOCAL DEV VERIFIED') {
        primary = new Error(`required verification check failed: ${step.name}`);
        break;
      }
    }
  } catch (error) {
    primary = error;
  }
  let cleanupError: unknown;
  try { await cleanup(); } catch (error) { cleanupError = error; }
  if (primary && cleanupError) throw new AggregateError([primary, cleanupError], 'verification and cleanup failed');
  if (primary) throw primary;
  if (cleanupError) throw cleanupError;
  return checks;
}
