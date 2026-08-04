#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 9020;
const DEFAULT_PID_PATH = '/tmp/webtopup-provider-sandbox.pid';
const DEFAULT_LOG_PATH = '/tmp/webtopup-provider-sandbox.log';

const STUB_PATH = path.resolve(__dirname, '../smoke/provider-sandbox-stub.js');
const REPO_ROOT = path.resolve(__dirname, '../..');

/** Fixed diagnostic error labels — never raw exception messages or env values. */
const ERROR = Object.freeze({
  usage: 'usage',
  unknown_command: 'unknown_command',
  invalid_bind: 'invalid_bind',
  foreign_listener: 'foreign_listener',
  foreign_pidfile: 'foreign_pidfile',
  ownership_unproven: 'ownership_unproven',
  spawn_failed: 'spawn_failed',
  spawn_identity: 'spawn_identity',
  readiness_failed: 'readiness_failed',
  stop_timeout: 'stop_timeout',
  signal_failed: 'signal_failed',
  internal: 'internal',
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeExe = (value) => path.resolve(String(value || '').replace(/ \(deleted\)$/, ''));

const expectedExecutable = () => normalizeExe(process.execPath);

const expectedArgv = () => [process.execPath, STUB_PATH];

const safeDiagnostics = (payload = {}) => {
  // Only fixed labels/status/pid plus fixed default path attribute names.
  const out = {
    status: payload.status,
    pidPath: DEFAULT_PID_PATH,
    logPath: DEFAULT_LOG_PATH,
  };
  if (Object.prototype.hasOwnProperty.call(payload, 'pid') && Number.isInteger(payload.pid)) {
    out.pid = payload.pid;
  }
  if (payload.idempotent === true) {
    out.idempotent = true;
  }
  if (typeof payload.error === 'string' && payload.error) {
    out.error = payload.error;
  }
  return out;
};

const printDiagnostics = (payload) => {
  process.stdout.write(`${JSON.stringify(safeDiagnostics(payload))}\n`);
};

const fail = (errorLabel, code = 1, extras = {}) => {
  printDiagnostics({ status: 'error', error: errorLabel, ...extras });
  process.exit(code);
};

/**
 * Operator bind is fixed: exact loopback host and exact development sandbox port.
 * Any other host/port (including 0.0.0.0) is rejected.
 */
const validateBindConfig = (host, port) => {
  const normalizedPort = Number(port);
  return host === DEFAULT_HOST && normalizedPort === DEFAULT_PORT;
};

const configFromEnv = () => {
  const host = process.env.PROVIDER_SANDBOX_HOST || DEFAULT_HOST;
  const port = Number(process.env.PROVIDER_SANDBOX_PORT || DEFAULT_PORT);
  if (!validateBindConfig(host, port)) {
    const err = new Error(ERROR.invalid_bind);
    err.code = ERROR.invalid_bind;
    throw err;
  }
  return {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    // Operator pid/log remain the fixed defaults for ownership semantics.
    // Tests may override paths only; diagnostics still print fixed defaults.
    pidPath: process.env.PROVIDER_SANDBOX_PID_PATH || DEFAULT_PID_PATH,
    logPath: process.env.PROVIDER_SANDBOX_LOG_PATH || DEFAULT_LOG_PATH,
  };
};

const readPidFile = (pidPath) => {
  try {
    const raw = fs.readFileSync(pidPath, 'utf8').trim();
    if (!raw) return null;
    const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const first = lines[0] || '';
    const parts = first.split(/\s+/);
    const pid = Number(parts[0]);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const startTime = parts[1] || lines[1] || null;
    if (!startTime) return null;
    return { pid, startTime: String(startTime) };
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    return null;
  }
};

const writePidFile = (pidPath, pid, startTime) => {
  const tmp = `${pidPath}.tmp`;
  const body = `${pid} ${startTime}\n`;
  fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, pidPath);
};

const removePidFile = (pidPath) => {
  try {
    fs.unlinkSync(pidPath);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
};

/**
 * Remove pidfile only when it still holds the exact pid + startTime record we wrote.
 * Otherwise leave it untouched (foreign / reused / never-ours).
 */
const removePidFileIfRecord = (pidPath, expected) => {
  if (!expected || !Number.isInteger(expected.pid) || !expected.startTime) return false;
  const current = readPidFile(pidPath);
  if (!current) return false;
  if (current.pid !== expected.pid || current.startTime !== String(expected.startTime)) {
    return false;
  }
  removePidFile(pidPath);
  return true;
};

/**
 * Signal only with immediate exact proof: owned argv/exe/cwd, sole listener on port,
 * and matching startTime. Never signal on missing/mismatched identity.
 * @returns {boolean} true if SIGTERM/SIGKILL (etc.) was sent
 */
const signalOwnedProcess = (pid, port, expectedStartTime, signal = 'SIGTERM') => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (expectedStartTime === undefined || expectedStartTime === null || expectedStartTime === '') {
    return false;
  }
  const owned = ownershipSnapshot(pid, port);
  if (!owned) return false;
  if (owned.startTime !== String(expectedStartTime)) return false;
  if (!processAlive(pid)) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
};

/**
 * Spawn-time identity not ready / mismatched: ownership was never established.
 * Do not signal. Only remove a pidfile if it still matches a record we wrote for this spawn.
 */
const cleanupSpawnWithoutProvenIdentity = ({
  pid,
  pidPath,
  writtenRecord = null,
} = {}) => {
  // Intentionally never signal: no exact argv/exe/cwd + startTime + sole-listener proof.
  void pid;
  if (writtenRecord) {
    removePidFileIfRecord(pidPath, writtenRecord);
  }
  // If we never wrote a matching record, leave any existing pidfile alone.
  return { error: ERROR.spawn_identity, signaled: false };
};

const processAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const readProcIdentity = (pid) => {
  const proc = `/proc/${pid}`;
  try {
    const cmdline = fs.readFileSync(`${proc}/cmdline`);
    const command = cmdline.toString('utf8').split('\0').filter(Boolean);
    const executable = fs.readlinkSync(`${proc}/exe`);
    const cwd = fs.readlinkSync(`${proc}/cwd`);
    const stat = fs.readFileSync(`${proc}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    const fields = stat.slice(close + 2).split(' ');
    const startTime = fields[19];
    return { pid, command, executable, cwd, startTime };
  } catch {
    return null;
  }
};

/**
 * Exact ownership: argv array must be [process.execPath, absolute STUB_PATH]
 * as observed in /proc (no substring matching). Executable and cwd must match
 * the spawn-time process.execPath and repo root.
 */
const isExactOwnedArgv = (command, expected = expectedArgv()) => {
  if (!Array.isArray(command) || command.length !== 2) return false;
  if (path.resolve(command[0]) !== path.resolve(expected[0])) return false;
  if (path.resolve(command[1]) !== path.resolve(expected[1])) return false;
  return true;
};

const looksLikeOwnedSandbox = (identity, expected = {}) => {
  if (!identity) return false;
  const exe = expected.executable || expectedExecutable();
  const cwd = expected.cwd || REPO_ROOT;
  const argv = expected.argv || expectedArgv();
  if (!isExactOwnedArgv(identity.command, argv)) return false;
  if (normalizeExe(identity.executable) !== normalizeExe(exe)) return false;
  if (path.resolve(identity.cwd) !== path.resolve(cwd)) return false;
  return true;
};

const parseHexIpPort = (hexAddress) => {
  const [ipHex, portHex] = String(hexAddress || '').split(':');
  if (!ipHex || !portHex) return null;
  const port = Number.parseInt(portHex, 16);
  if (!Number.isInteger(port)) return null;
  // IPv4 only for operator contract (loopback 127.0.0.1).
  if (ipHex.length !== 8) return { port, ip: null };
  const bytes = ipHex.match(/../g).map((part) => Number.parseInt(part, 16));
  const ip = `${bytes[3]}.${bytes[2]}.${bytes[1]}.${bytes[0]}`;
  return { port, ip };
};

/**
 * Any TCP listener on the sandbox port (127.0.0.1 or 0.0.0.0) is relevant.
 * Owned state additionally requires the listener set to be exactly the owned PID.
 */
const listListeningPidsOnPort = (port) => {
  const tables = ['/proc/net/tcp'];
  const inodes = new Set();
  for (const table of tables) {
    let content = '';
    try {
      content = fs.readFileSync(table, 'utf8');
    } catch {
      continue;
    }
    for (const line of content.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 10) continue;
      if (fields[3] !== '0A') continue; // TCP_LISTEN
      const parsed = parseHexIpPort(fields[1]);
      if (!parsed || parsed.port !== port) continue;
      // Count loopback and wildcard binds; both block safe ownership.
      if (parsed.ip && parsed.ip !== DEFAULT_HOST && parsed.ip !== '0.0.0.0') continue;
      inodes.add(fields[9]);
    }
  }

  if (inodes.size === 0) return [];

  const pids = new Set();
  let procEntries = [];
  try {
    procEntries = fs.readdirSync('/proc');
  } catch {
    return [];
  }

  for (const entry of procEntries) {
    if (!/^\d+$/.test(entry)) continue;
    const fdDir = `/proc/${entry}/fd`;
    let fds = [];
    try {
      fds = fs.readdirSync(fdDir);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let link = '';
      try {
        link = fs.readlinkSync(path.join(fdDir, fd));
      } catch {
        continue;
      }
      const match = /^socket:\[(\d+)\]$/.exec(link);
      if (match && inodes.has(match[1])) {
        pids.add(Number(entry));
      }
    }
  }
  return [...pids];
};

const healthCheck = (host, port, timeoutMs = 500) => new Promise((resolve) => {
  const req = http.request(
    {
      host,
      port,
      path: '/health',
      method: 'GET',
      timeout: timeoutMs,
    },
    (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = raw ? JSON.parse(raw) : null;
        } catch {
          json = null;
        }
        resolve({
          ok: res.statusCode === 200
            && json
            && json.status === 'ok'
            && json.service === 'provider-sandbox',
          statusCode: res.statusCode,
        });
      });
    },
  );
  req.on('timeout', () => {
    req.destroy();
    resolve({ ok: false, statusCode: 0 });
  });
  req.on('error', () => resolve({ ok: false, statusCode: 0 }));
  req.end();
});

const waitForCondition = async (predicate, { timeoutMs = 5000, intervalMs = 50 } = {}) => {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await predicate();
    if (last) return last;
    await sleep(intervalMs);
  }
  return last;
};

/**
 * Owned running/degraded requires exact process identity AND listener set
 * exactly equal to that single PID.
 */
const ownershipSnapshot = (pid, port, expected) => {
  const identity = readProcIdentity(pid);
  if (!identity || !looksLikeOwnedSandbox(identity, expected)) return null;
  const listeners = listListeningPidsOnPort(port);
  if (listeners.length !== 1 || listeners[0] !== pid) return null;
  return {
    pid,
    command: identity.command,
    executable: identity.executable,
    cwd: identity.cwd,
    startTime: identity.startTime,
    listeners,
  };
};

const resolveOwnedRunning = async (cfg) => {
  const recorded = readPidFile(cfg.pidPath);
  if (recorded && processAlive(recorded.pid)) {
    const owned = ownershipSnapshot(recorded.pid, cfg.port);
    if (owned && owned.startTime === recorded.startTime) {
      const health = await healthCheck(cfg.host, cfg.port);
      return { ...owned, health: health.ok ? 'ok' : 'degraded' };
    }
  }

  // Stale or missing PID: see if an owned listener already exists.
  const listeners = listListeningPidsOnPort(cfg.port);
  if (listeners.length === 1) {
    const owned = ownershipSnapshot(listeners[0], cfg.port);
    if (owned) {
      const health = await healthCheck(cfg.host, cfg.port);
      return { ...owned, health: health.ok ? 'ok' : 'degraded' };
    }
  }
  return null;
};

const ensureNoForeignListener = (cfg, ownedPid = null) => {
  const listeners = listListeningPidsOnPort(cfg.port);
  if (listeners.length === 0) return;
  for (const pid of listeners) {
    if (ownedPid !== null && pid === ownedPid) {
      const owned = ownershipSnapshot(pid, cfg.port);
      if (owned) continue;
    }
    // Any non-owned / ambiguous listener fails closed.
    fail(ERROR.foreign_listener, 1);
  }
};

const startSandbox = async (cfg) => {
  const existing = await resolveOwnedRunning(cfg);
  if (existing && existing.health === 'ok') {
    writePidFile(cfg.pidPath, existing.pid, existing.startTime);
    printDiagnostics({
      status: 'running',
      pid: existing.pid,
      idempotent: true,
    });
    return;
  }

  // Clear stale PID when process is dead or not owned.
  const stale = readPidFile(cfg.pidPath);
  if (stale && !processAlive(stale.pid)) {
    removePidFile(cfg.pidPath);
  } else if (stale && processAlive(stale.pid)) {
    const identity = readProcIdentity(stale.pid);
    if (!looksLikeOwnedSandbox(identity) || identity.startTime !== stale.startTime) {
      // PID file points at unrelated or reused process — fail closed rather than clobber.
      fail(ERROR.foreign_pidfile, 1);
    }
  }

  ensureNoForeignListener(cfg, existing ? existing.pid : null);

  if (existing && existing.health !== 'ok') {
    // Owned but degraded: re-verify startTime then stop and restart.
    const before = ownershipSnapshot(existing.pid, cfg.port);
    const recorded = readPidFile(cfg.pidPath);
    if (
      !before
      || !recorded
      || before.startTime !== recorded.startTime
      || before.startTime !== existing.startTime
    ) {
      fail(ERROR.ownership_unproven, 1);
    }
    if (!signalOwnedProcess(existing.pid, cfg.port, existing.startTime, 'SIGTERM')) {
      fail(ERROR.signal_failed, 1);
    }
    await waitForCondition(async () => !processAlive(existing.pid), { timeoutMs: 3000, intervalMs: 50 });
    removePidFileIfRecord(cfg.pidPath, {
      pid: existing.pid,
      startTime: existing.startTime,
    });
    ensureNoForeignListener(cfg, null);
  }

  fs.mkdirSync(path.dirname(cfg.logPath), { recursive: true });
  const logFd = fs.openSync(cfg.logPath, 'a', 0o600);
  const child = spawn(process.execPath, [STUB_PATH], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PROVIDER_SANDBOX_HOST: DEFAULT_HOST,
      PROVIDER_SANDBOX_PORT: String(DEFAULT_PORT),
    },
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  fs.closeSync(logFd);
  child.unref();

  if (!child.pid) {
    fail(ERROR.spawn_failed, 1);
  }

  // Wait until /proc identity is readable so startTime can be persisted atomically.
  const identityReady = await waitForCondition(async () => {
    if (!processAlive(child.pid)) return false;
    return readProcIdentity(child.pid);
  }, { timeoutMs: 3000, intervalMs: 20 });

  if (!identityReady || !looksLikeOwnedSandbox(identityReady)) {
    // Identity not proven yet: never signal. Only drop a pidfile we wrote (none yet).
    cleanupSpawnWithoutProvenIdentity({
      pid: child.pid,
      pidPath: cfg.pidPath,
      writtenRecord: null,
    });
    fail(ERROR.spawn_identity, 1);
  }

  writePidFile(cfg.pidPath, child.pid, identityReady.startTime);

  const ready = await waitForCondition(async () => {
    if (!processAlive(child.pid)) return false;
    const owned = ownershipSnapshot(child.pid, cfg.port);
    if (!owned || owned.startTime !== identityReady.startTime) return false;
    const health = await healthCheck(cfg.host, cfg.port);
    return health.ok ? owned : false;
  }, { timeoutMs: 5000, intervalMs: 50 });

  if (!ready) {
    const recorded = readPidFile(cfg.pidPath);
    // Signal only with immediate ownership + matching recorded startTime + sole listener.
    if (recorded) {
      signalOwnedProcess(child.pid, cfg.port, recorded.startTime, 'SIGTERM');
      removePidFileIfRecord(cfg.pidPath, recorded);
    }
    fail(ERROR.readiness_failed, 1);
  }

  printDiagnostics({
    status: 'running',
    pid: child.pid,
  });
};

const statusSandbox = async (cfg) => {
  const owned = await resolveOwnedRunning(cfg);
  if (!owned) {
    const listeners = listListeningPidsOnPort(cfg.port);
    if (listeners.length > 0) {
      printDiagnostics({
        status: 'foreign',
      });
      return;
    }
    printDiagnostics({
      status: 'stopped',
    });
    return;
  }

  printDiagnostics({
    status: owned.health === 'ok' ? 'running' : 'degraded',
    pid: owned.pid,
  });
};

const stopSandbox = async (cfg) => {
  const owned = await resolveOwnedRunning(cfg);
  if (!owned) {
    const recorded = readPidFile(cfg.pidPath);
    if (recorded && !processAlive(recorded.pid)) {
      removePidFile(cfg.pidPath);
    } else if (recorded && processAlive(recorded.pid)) {
      const identity = readProcIdentity(recorded.pid);
      if (!looksLikeOwnedSandbox(identity) || identity.startTime !== recorded.startTime) {
        fail(ERROR.foreign_pidfile, 1);
      }
    }
    printDiagnostics({
      status: 'stopped',
    });
    return;
  }

  // Re-verify identity + startTime immediately before signal (PID reuse close).
  const before = ownershipSnapshot(owned.pid, cfg.port);
  const recorded = readPidFile(cfg.pidPath);
  if (
    !before
    || !recorded
    || before.startTime !== recorded.startTime
    || before.startTime !== owned.startTime
  ) {
    fail(ERROR.ownership_unproven, 1);
  }

  // Immediate re-check: exact ownership + startTime + sole listener immediately before signal.
  if (!signalOwnedProcess(owned.pid, cfg.port, owned.startTime, 'SIGTERM')) {
    fail(ERROR.signal_failed, 1);
  }

  const exited = await waitForCondition(async () => !processAlive(owned.pid), {
    timeoutMs: 5000,
    intervalMs: 50,
  });

  if (!exited) {
    fail(ERROR.stop_timeout, 1);
  }

  removePidFileIfRecord(cfg.pidPath, {
    pid: owned.pid,
    startTime: owned.startTime,
  });
  printDiagnostics({
    status: 'stopped',
  });
};

const main = async (argv = process.argv.slice(2)) => {
  const command = String(argv[0] || '').trim().toLowerCase();
  if (!command) {
    fail(ERROR.usage, 2);
  }

  let cfg;
  try {
    cfg = configFromEnv();
  } catch (error) {
    if (error && error.code === ERROR.invalid_bind) {
      fail(ERROR.invalid_bind, 1);
    }
    fail(ERROR.internal, 1);
  }

  if (command === 'start') {
    await startSandbox(cfg);
    return;
  }
  if (command === 'status') {
    await statusSandbox(cfg);
    return;
  }
  if (command === 'stop') {
    await stopSandbox(cfg);
    return;
  }

  fail(ERROR.unknown_command, 2);
};

module.exports = {
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_PID_PATH,
  DEFAULT_LOG_PATH,
  STUB_PATH,
  REPO_ROOT,
  ERROR,
  main,
  configFromEnv,
  validateBindConfig,
  safeDiagnostics,
  readPidFile,
  writePidFile,
  removePidFile,
  removePidFileIfRecord,
  signalOwnedProcess,
  cleanupSpawnWithoutProvenIdentity,
  readProcIdentity,
  isExactOwnedArgv,
  looksLikeOwnedSandbox,
  ownershipSnapshot,
  listListeningPidsOnPort,
  expectedArgv,
  expectedExecutable,
};

if (require.main === module) {
  main().catch(() => {
    fail(ERROR.internal, 1);
  });
}
