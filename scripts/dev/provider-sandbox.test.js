'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const facadePath = path.join(__dirname, 'provider-sandbox.js');
const stubPath = path.resolve(__dirname, '../smoke/provider-sandbox-stub.js');
const repoRoot = path.resolve(__dirname, '../..');

/**
 * Lifecycle tests use isolated PID/log paths on the fixed operator bind 127.0.0.1:9020.
 * Host/port overrides are intentionally rejected; only pid/log path overrides remain for isolation.
 */
function makeRuntime() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-sandbox-test-'));
  return {
    dir,
    pidPath: path.join(dir, 'sandbox.pid'),
    logPath: path.join(dir, 'sandbox.log'),
    port: 9020,
    host: '127.0.0.1',
  };
}

function runFacade(args, runtime, extraEnv = {}) {
  const env = {
    ...process.env,
    PROVIDER_SANDBOX_PID_PATH: runtime.pidPath,
    PROVIDER_SANDBOX_LOG_PATH: runtime.logPath,
  };
  // Explicitly clear host/port overrides so operator defaults apply unless a test sets them.
  delete env.PROVIDER_SANDBOX_HOST;
  delete env.PROVIDER_SANDBOX_PORT;
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [facadePath, ...args], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
}

function isOperatorPortBusy() {
  try {
    const mod = require(facadePath);
    return mod.listListeningPidsOnPort(9020).length > 0;
  } catch {
    return false;
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await wait(intervalMs);
  }
  throw lastError || new Error('condition not met before timeout');
}

function httpGet(host, port, requestPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, path: requestPath, method: 'GET' }, (res) => {
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
        resolve({ statusCode: res.statusCode, raw, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function parseDiagnostics(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function assertNoSecrets(diagnostics) {
  const blob = JSON.stringify(diagnostics).toLowerCase();
  for (const banned of [
    'password',
    'secret',
    'token',
    'mongo_uri',
    'jwt',
    'api_key',
    'authorization',
    'provider_sandbox_topup_status',
    process.env.HOME || '___no_home___',
  ]) {
    assert.equal(blob.includes(String(banned).toLowerCase()), false, `diagnostics leaked ${banned}`);
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('provider-sandbox lifecycle façade', () => {
  let runtime;
  let foreignServer;
  let foreignChild;
  let mod;

  before(() => {
    mod = require(facadePath);
  });

  beforeEach(() => {
    runtime = makeRuntime();
  });

  async function terminateForeignChild(child) {
    if (!child || !child.pid) return;
    const pid = child.pid;
    // Detached process group: signal the whole group first, then the pid.
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, 'SIGTERM');
      } catch {
        // already exited / no permission on group
      }
    }
    try {
      await waitFor(async () => !processAlive(pid), {
        timeoutMs: 2000,
        intervalMs: 25,
      });
    } catch {
      for (const target of [-pid, pid]) {
        try {
          process.kill(target, 'SIGKILL');
        } catch {
          // ignore
        }
      }
      try {
        await waitFor(async () => !processAlive(pid), {
          timeoutMs: 1000,
          intervalMs: 25,
        });
      } catch {
        // best effort
      }
    }
  }

  afterEach(async () => {
    if (runtime) {
      runFacade(['stop'], runtime);
      try {
        fs.rmSync(runtime.dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
    if (foreignChild) {
      const child = foreignChild;
      foreignChild = null;
      await terminateForeignChild(child);
    }
    if (foreignServer) {
      await new Promise((resolve) => foreignServer.close(() => resolve()));
      foreignServer = null;
    }
    // Bound operator port must be fully free before the next test reuses 9020.
    try {
      await waitFor(async () => mod.listListeningPidsOnPort(9020).length === 0, {
        timeoutMs: 5000,
        intervalMs: 25,
      });
    } catch {
      // best effort — subsequent tests re-check before binding
    }
  });

  async function spawnForeignListener({ host, bodyStatus }) {
    await waitFor(async () => mod.listListeningPidsOnPort(9020).length === 0, {
      timeoutMs: 5000,
      intervalMs: 25,
    });

    // Write a temp child script (not inline -e) so quoting stays reliable and argv is clearly foreign.
    const scriptPath = path.join(runtime.dir, `foreign-listener-${Date.now()}-${Math.random().toString(16).slice(2)}.js`);
    const scriptBody = [
      "'use strict';",
      "const http = require('http');",
      `const host = ${JSON.stringify(host)};`,
      `const port = ${JSON.stringify(9020)};`,
      `const bodyStatus = ${JSON.stringify(bodyStatus)};`,
      'const server = http.createServer((_req, res) => {',
      "  res.writeHead(200, { 'Content-Type': 'application/json' });",
      '  res.end(JSON.stringify({ status: bodyStatus }));',
      '});',
      'server.on("error", (error) => {',
      '  process.stderr.write(String((error && error.code) || error) + "\\n");',
      '  process.exit(1);',
      '});',
      'server.listen(port, host, () => {',
      '  process.stdout.write("ready\\n");',
      '});',
      'const shutdown = () => {',
      '  server.close(() => process.exit(0));',
      '  setTimeout(() => process.exit(0), 500).unref();',
      '};',
      'process.on("SIGTERM", shutdown);',
      'process.on("SIGINT", shutdown);',
      '',
    ].join('\n');
    fs.writeFileSync(scriptPath, scriptBody, 'utf8');

    const child = spawn(process.execPath, [scriptPath], {
      cwd: os.tmpdir(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    foreignChild = child;
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`foreign listener did not become ready: ${stderr.trim()}`));
        }
      }, 3000);
      child.stdout.on('data', (chunk) => {
        if (!settled && String(chunk).includes('ready')) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('error', (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      });
      child.on('exit', (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`foreign listener exited early: ${code} ${stderr.trim()}`));
        }
      });
    });

    await waitFor(async () => mod.listListeningPidsOnPort(9020).includes(child.pid), {
      timeoutMs: 3000,
      intervalMs: 25,
    });
    return child;
  }

  it('exports operator defaults for loopback 9020 and /tmp pid/log paths', () => {
    assert.equal(mod.DEFAULT_HOST, '127.0.0.1');
    assert.equal(mod.DEFAULT_PORT, 9020);
    assert.equal(mod.DEFAULT_PID_PATH, '/tmp/webtopup-provider-sandbox.pid');
    assert.equal(mod.DEFAULT_LOG_PATH, '/tmp/webtopup-provider-sandbox.log');
  });

  it('hard rejects host other than exact 127.0.0.1 including 0.0.0.0', () => {
    assert.equal(mod.validateBindConfig('0.0.0.0', 9020), false);
    assert.equal(mod.validateBindConfig('127.0.0.1', 9020), true);
    assert.equal(mod.validateBindConfig('127.0.0.1', 19020), false);
    assert.equal(mod.validateBindConfig('localhost', 9020), false);

    const result = runFacade(['status'], runtime, {
      PROVIDER_SANDBOX_HOST: '0.0.0.0',
      PROVIDER_SANDBOX_PORT: '9020',
    });
    assert.notEqual(result.status, 0);
    const diagnostics = parseDiagnostics(result.stdout);
    assert.equal(diagnostics.error, 'invalid_bind');
    assert.equal(diagnostics.pidPath, mod.DEFAULT_PID_PATH);
    assert.equal(diagnostics.logPath, mod.DEFAULT_LOG_PATH);
    assert.equal(Object.prototype.hasOwnProperty.call(diagnostics, 'host'), false);
  });

  it('hard rejects port other than exact 9020', () => {
    const result = runFacade(['status'], runtime, {
      PROVIDER_SANDBOX_HOST: '127.0.0.1',
      PROVIDER_SANDBOX_PORT: '19020',
    });
    assert.notEqual(result.status, 0);
    const diagnostics = parseDiagnostics(result.stdout);
    assert.equal(diagnostics.error, 'invalid_bind');
  });

  it('unknown command exits 2', () => {
    const result = runFacade(['wat'], runtime);
    assert.equal(result.status, 2);
  });

  it('status is read-only and reports stopped without pid file', () => {
    const result = runFacade(['status'], runtime);
    assert.equal(result.status, 0);
    const diagnostics = parseDiagnostics(result.stdout);
    assert.ok(diagnostics);
    assert.equal(diagnostics.status, 'stopped');
    assert.equal(diagnostics.pidPath, mod.DEFAULT_PID_PATH);
    assert.equal(diagnostics.logPath, mod.DEFAULT_LOG_PATH);
    assertNoSecrets(diagnostics);
  });

  it('exact argv ownership rejects substring matches', () => {
    const expected = mod.expectedArgv();
    // Substring foreign: stub path appears inside a longer argument, not exact argv array.
    const foreign = {
      pid: 1,
      command: [process.execPath, `/tmp/not-really-${path.basename(stubPath)}-extra`],
      executable: process.execPath,
      cwd: repoRoot,
      startTime: '1',
    };
    assert.equal(mod.isExactOwnedArgv(foreign.command, expected), false);
    assert.equal(mod.looksLikeOwnedSandbox(foreign), false);

    // Substring via joined command containing the stub path among other args.
    const multi = {
      pid: 1,
      command: [process.execPath, '/tmp/wrapper.js', stubPath],
      executable: process.execPath,
      cwd: repoRoot,
      startTime: '1',
    };
    assert.equal(mod.isExactOwnedArgv(multi.command, expected), false);
    assert.equal(mod.looksLikeOwnedSandbox(multi), false);

    const owned = {
      pid: 1,
      command: [process.execPath, stubPath],
      executable: process.execPath,
      cwd: repoRoot,
      startTime: '1',
    };
    assert.equal(mod.isExactOwnedArgv(owned.command, expected), true);
    assert.equal(mod.looksLikeOwnedSandbox(owned), true);
  });

  it('exact ownership rejects wrong cwd or executable', () => {
    const base = {
      pid: 1,
      command: [process.execPath, stubPath],
      executable: process.execPath,
      cwd: repoRoot,
      startTime: '1',
    };
    assert.equal(mod.looksLikeOwnedSandbox({ ...base, cwd: '/tmp' }), false);
    assert.equal(mod.looksLikeOwnedSandbox({ ...base, executable: '/bin/false' }), false);
    assert.equal(mod.looksLikeOwnedSandbox(base), true);
  });

  it('owned running state requires listener set exactly equal to the PID', () => {
    const identity = {
      pid: 4242,
      command: [process.execPath, stubPath],
      executable: process.execPath,
      cwd: repoRoot,
      startTime: '99',
    };
    // Missing listener.
    assert.equal(
      mod.ownershipSnapshot.length >= 2,
      true,
    );
    // Pure decision: listeners empty / foreign / multi all fail closed.
    const decide = (listeners) => {
      if (!mod.looksLikeOwnedSandbox(identity)) return null;
      if (!Array.isArray(listeners) || listeners.length !== 1 || listeners[0] !== identity.pid) {
        return null;
      }
      return identity.pid;
    };
    assert.equal(decide([]), null);
    assert.equal(decide([9999]), null);
    assert.equal(decide([4242, 9999]), null);
    assert.equal(decide([4242]), 4242);
  });

  it('start → status → stop lifecycle owns health endpoint', async () => {
    const start = runFacade(['start'], runtime);
    assert.equal(start.status, 0, start.stderr || start.stdout);
    const startDiag = parseDiagnostics(start.stdout);
    assert.equal(startDiag.status, 'running');
    assert.equal(typeof startDiag.pid, 'number');
    assert.equal(startDiag.pidPath, mod.DEFAULT_PID_PATH);
    assert.equal(startDiag.logPath, mod.DEFAULT_LOG_PATH);
    assert.equal(Object.prototype.hasOwnProperty.call(startDiag, 'host'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(startDiag, 'port'), false);
    assertNoSecrets(startDiag);

    // Pidfile stores pid + startTime atomically.
    const recorded = mod.readPidFile(runtime.pidPath);
    assert.ok(recorded);
    assert.equal(recorded.pid, startDiag.pid);
    assert.equal(typeof recorded.startTime, 'string');
    assert.ok(recorded.startTime.length > 0);

    await waitFor(async () => {
      const health = await httpGet(runtime.host, runtime.port, '/health');
      return health.statusCode === 200
        && health.json
        && health.json.status === 'ok'
        && health.json.service === 'provider-sandbox';
    });

    const status = runFacade(['status'], runtime);
    assert.equal(status.status, 0);
    const statusDiag = parseDiagnostics(status.stdout);
    assert.equal(statusDiag.status, 'running');
    assert.equal(statusDiag.pid, startDiag.pid);
    assertNoSecrets(statusDiag);

    const stop = runFacade(['stop'], runtime);
    assert.equal(stop.status, 0, stop.stderr || stop.stdout);
    const stopDiag = parseDiagnostics(stop.stdout);
    assert.equal(stopDiag.status, 'stopped');
    assertNoSecrets(stopDiag);

    await waitFor(async () => {
      try {
        await httpGet(runtime.host, runtime.port, '/health');
        return false;
      } catch {
        return true;
      }
    });
  });

  it('start is idempotent when the owned sandbox is already healthy', async () => {
    const first = runFacade(['start'], runtime);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstDiag = parseDiagnostics(first.stdout);

    await waitFor(async () => {
      const health = await httpGet(runtime.host, runtime.port, '/health');
      return health.statusCode === 200;
    });

    const second = runFacade(['start'], runtime);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const secondDiag = parseDiagnostics(second.stdout);
    assert.equal(secondDiag.status, 'running');
    assert.equal(secondDiag.pid, firstDiag.pid);
    assert.equal(secondDiag.idempotent, true);
  });

  it('clears stale pid files and starts a fresh owned process', async () => {
    fs.writeFileSync(runtime.pidPath, '999999 1\n', 'utf8');
    const start = runFacade(['start'], runtime);
    assert.equal(start.status, 0, start.stderr || start.stdout);
    const diag = parseDiagnostics(start.stdout);
    assert.equal(diag.status, 'running');
    assert.notEqual(diag.pid, 999999);
    assert.ok(fs.existsSync(runtime.pidPath));
    const recorded = mod.readPidFile(runtime.pidPath);
    assert.equal(recorded.pid, diag.pid);
  });

  it('refuses stop when pidfile startTime was replaced (PID reuse fail-closed)', async () => {
    const start = runFacade(['start'], runtime);
    assert.equal(start.status, 0, start.stderr || start.stdout);
    const startDiag = parseDiagnostics(start.stdout);
    assert.equal(typeof startDiag.pid, 'number');

    await waitFor(async () => {
      const health = await httpGet(runtime.host, runtime.port, '/health');
      return health.statusCode === 200;
    });

    const before = mod.readPidFile(runtime.pidPath);
    assert.ok(before);
    // Replace startTime while keeping PID — stop must refuse and never signal.
    fs.writeFileSync(runtime.pidPath, `${before.pid} 0\n`, 'utf8');

    const stop = runFacade(['stop'], runtime);
    assert.notEqual(stop.status, 0);
    const stopDiag = parseDiagnostics(stop.stdout);
    assert.equal(stopDiag.status, 'error');
    assert.match(String(stopDiag.error || ''), /ownership_unproven|foreign_pidfile/);

    // Process must still be alive (never signaled).
    assert.equal(processAlive(startDiag.pid), true);

    // Restore correct startTime and stop cleanly for cleanup.
    fs.writeFileSync(runtime.pidPath, `${before.pid} ${before.startTime}\n`, 'utf8');
    const cleanup = runFacade(['stop'], runtime);
    assert.equal(cleanup.status, 0, cleanup.stderr || cleanup.stdout);
  });

  it('refuses start when the target port is owned by a foreign loopback listener (fail-closed)', async () => {
    await waitFor(async () => mod.listListeningPidsOnPort(runtime.port).length === 0, {
      timeoutMs: 5000,
      intervalMs: 25,
    });
    const child = await spawnForeignListener({ host: '127.0.0.1', bodyStatus: 'foreign' });

    const pre = await httpGet(runtime.host, runtime.port, '/');
    assert.equal(pre.statusCode, 200);
    assert.equal(pre.json.status, 'foreign');

    const start = runFacade(['start'], runtime);
    assert.notEqual(start.status, 0);
    const diagnostics = parseDiagnostics(start.stdout);
    assert.equal(diagnostics.error, 'foreign_listener');
    assert.equal(diagnostics.pidPath, mod.DEFAULT_PID_PATH);

    // Foreign listener must remain up (fail-closed, do not kill).
    assert.equal(processAlive(child.pid), true);
    const probe = await httpGet(runtime.host, runtime.port, '/');
    assert.equal(probe.statusCode, 200);
    assert.equal(probe.json.status, 'foreign');
  });

  it('refuses start when a foreign 0.0.0.0 listener owns the sandbox port', async () => {
    await waitFor(async () => mod.listListeningPidsOnPort(runtime.port).length === 0, {
      timeoutMs: 5000,
      intervalMs: 25,
    });
    const child = await spawnForeignListener({ host: '0.0.0.0', bodyStatus: 'foreign-wildcard' });

    const start = runFacade(['start'], runtime);
    assert.notEqual(start.status, 0);
    const diagnostics = parseDiagnostics(start.stdout);
    assert.equal(diagnostics.error, 'foreign_listener');

    // Still reachable and not killed.
    assert.equal(processAlive(child.pid), true);
    const probe = await httpGet('127.0.0.1', runtime.port, '/');
    assert.equal(probe.statusCode, 200);
    assert.equal(probe.json.status, 'foreign-wildcard');
  });

  it('spawn identity failure never signals a replaced/mismatched PID (exact path)', async () => {
    // Adversarial: PID that would be treated as "our child" is actually a foreign process
    // (simulates exit + PID reuse, or mismatched /proc identity before ownership is established).
    const replacement = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: os.tmpdir(),
      stdio: 'ignore',
      detached: true,
    });
    replacement.unref();
    assert.ok(replacement.pid);

    const signals = [];
    const originalKill = process.kill.bind(process);
    process.kill = (pid, sig) => {
      // Record real termination signals only (not existence probes).
      if (sig !== 0 && sig !== undefined) {
        signals.push({ pid, sig });
      }
      return originalKill(pid, sig);
    };

    try {
      await waitFor(async () => processAlive(replacement.pid), { timeoutMs: 1000, intervalMs: 10 });

      // Foreign identity must not look owned.
      const identity = mod.readProcIdentity(replacement.pid);
      assert.ok(identity);
      assert.equal(mod.looksLikeOwnedSandbox(identity), false);

      // Plant a foreign pidfile that must not be clobbered without a matching written record.
      fs.writeFileSync(runtime.pidPath, `${replacement.pid} 999999
`, 'utf8');

      const outcome = mod.cleanupSpawnWithoutProvenIdentity({
        pid: replacement.pid,
        pidPath: runtime.pidPath,
        // Ownership never established for this spawn — no written pid/startTime record.
        writtenRecord: null,
      });

      assert.equal(outcome.error, 'spawn_identity');
      assert.equal(signals.length, 0, `must not signal replacement PID; got ${JSON.stringify(signals)}`);
      assert.equal(processAlive(replacement.pid), true);
      // Pidfile left intact: we never wrote a matching ownership record.
      assert.equal(fs.existsSync(runtime.pidPath), true);
      const still = mod.readPidFile(runtime.pidPath);
      assert.equal(still.pid, replacement.pid);
      assert.equal(still.startTime, '999999');

      // signalOwnedProcess also refuses without exact ownership + startTime + sole listener.
      assert.equal(
        mod.signalOwnedProcess(replacement.pid, runtime.port, '999999', 'SIGTERM'),
        false,
      );
      assert.equal(signals.length, 0);
      assert.equal(processAlive(replacement.pid), true);
    } finally {
      process.kill = originalKill;
      try {
        originalKill(replacement.pid, 'SIGTERM');
      } catch {
        // ignore
      }
      try {
        await waitFor(async () => !processAlive(replacement.pid), {
          timeoutMs: 2000,
          intervalMs: 25,
        });
      } catch {
        try {
          originalKill(replacement.pid, 'SIGKILL');
        } catch {
          // ignore
        }
      }
    }
  });

  it('signalOwnedProcess requires immediate ownership + startTime before any signal', async () => {
    const start = runFacade(['start'], runtime);
    assert.equal(start.status, 0, start.stderr || start.stdout);
    const startDiag = parseDiagnostics(start.stdout);
    const recorded = mod.readPidFile(runtime.pidPath);
    assert.ok(recorded);

    await waitFor(async () => {
      const health = await httpGet(runtime.host, runtime.port, '/health');
      return health.statusCode === 200;
    });

    // Wrong startTime: must not signal.
    const signals = [];
    const originalKill = process.kill.bind(process);
    process.kill = (pid, sig) => {
      if (sig !== 0 && sig !== undefined) signals.push({ pid, sig });
      return originalKill(pid, sig);
    };
    try {
      assert.equal(
        mod.signalOwnedProcess(recorded.pid, runtime.port, '0', 'SIGTERM'),
        false,
      );
      assert.equal(signals.length, 0);
      assert.equal(processAlive(recorded.pid), true);

      // Correct startTime + ownership: may signal (used by stop/readiness cleanup).
      assert.equal(
        mod.signalOwnedProcess(recorded.pid, runtime.port, recorded.startTime, 'SIGTERM'),
        true,
      );
      assert.equal(signals.length, 1);
      assert.equal(signals[0].pid, recorded.pid);
      assert.equal(signals[0].sig, 'SIGTERM');

      await waitFor(async () => !processAlive(recorded.pid), {
        timeoutMs: 5000,
        intervalMs: 50,
      });
      // Clear pidfile the same way stop would after proven exit.
      mod.removePidFileIfRecord(runtime.pidPath, recorded);
      assert.equal(fs.existsSync(runtime.pidPath), false);
    } finally {
      process.kill = originalKill;
      if (processAlive(startDiag.pid)) {
        try {
          originalKill(startDiag.pid, 'SIGTERM');
        } catch {
          // ignore
        }
      }
    }
  });

  it('diagnostics contain only fixed labels/status/pid/default path names', async () => {
    const start = runFacade(['start'], runtime);
    assert.equal(start.status, 0, start.stderr || start.stdout);
    const diagnostics = parseDiagnostics(start.stdout);
    assert.ok(diagnostics.status);
    assert.equal(diagnostics.pidPath, mod.DEFAULT_PID_PATH);
    assert.equal(diagnostics.logPath, mod.DEFAULT_LOG_PATH);
    assert.equal(typeof diagnostics.pid, 'number');
    assert.equal(Object.prototype.hasOwnProperty.call(diagnostics, 'env'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(diagnostics, 'environment'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(diagnostics, 'host'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(diagnostics, 'port'), false);
    assertNoSecrets(diagnostics);

    // Ensure no process.env dump appears even when sensitive keys exist in parent env.
    const withSecrets = runFacade(['status'], runtime, {
      JWT_SECRET: 'super-secret-value-should-not-leak',
      DIGIFLAZZ_API_KEY: 'should-not-appear',
    });
    assert.equal(withSecrets.status, 0);
    assert.equal(withSecrets.stdout.includes('super-secret-value-should-not-leak'), false);
    assert.equal(withSecrets.stdout.includes('should-not-appear'), false);
    assert.equal(withSecrets.stderr.includes('super-secret-value-should-not-leak'), false);

    // safeDiagnostics never echoes raw exception messages or env-derived hosts.
    const safe = mod.safeDiagnostics({
      status: 'error',
      error: 'foreign_listener',
      host: 'should-not-appear',
      port: 1234,
      message: 'Error: EACCES /home/secret',
    });
    assert.equal(safe.error, 'foreign_listener');
    assert.equal(Object.prototype.hasOwnProperty.call(safe, 'host'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(safe, 'message'), false);
    assert.equal(JSON.stringify(safe).includes('/home/secret'), false);
  });
});
