import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { activateFault, readFaultEvidence } from '../faults.ts';
import { MAX_TARGET_RESPONSE_BYTES, startFaultProxy } from '../faultProxy.ts';

const listen = async (server: http.Server): Promise<number> => {
  await new Promise<void>((resolve, reject) => { server.listen(0, '127.0.0.1', resolve); server.once('error', reject); });
  return (server.address() as { port: number }).port;
};
const request = (port: number, route: string, method = 'POST'): Promise<{ kind: 'response'; status: number; body: string } | { kind: 'lost' }> => new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port, path: route, method, headers: { 'content-type': 'application/json' } }, (res) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('aborted', () => resolve({ kind: 'lost' }));
    res.on('end', () => resolve({ kind: 'response', status: res.statusCode!, body: Buffer.concat(chunks).toString('utf8') }));
  });
  req.on('error', () => resolve({ kind: 'lost' }));
  req.end(method === 'GET' ? undefined : '{}');
});

test('fault proxy rejects non-loopback upstream origins', async () => {
  await assert.rejects(startFaultProxy({ stateDir: '/tmp/unused', upstreamOrigin: 'https://example.com', host: '127.0.0.1', port: 0 }), /loopback/);
});

test('fault proxy injects bounded one-shot transport and status scenarios only for exact refresh target', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webtopup-fault-matrix-'));
  const capability = 'synthetic-local-capability'; await fs.mkdir(path.join(stateDir, 'env'), { recursive: true }); await fs.writeFile(path.join(stateDir, 'env', 'shared.env'), 'LOCAL_DEV_VERIFICATION=true\n'); await fs.writeFile(path.join(stateDir, 'env', 'node.env'), `LOCAL_DESTRUCTIVE_CAPABILITY=${capability}\n`);
  const upstream = http.createServer((_req, res) => res.end('{"upstream":true}')); const upstreamPort = await listen(upstream); const proxy = await startFaultProxy({ stateDir, upstreamOrigin: `http://127.0.0.1:${upstreamPort}`, host: '127.0.0.1', port: 0 }); const proxyPort = (proxy.address() as { port: number }).port;
  try {
    for (const status of [400, 401, 403, 409, 429, 500, 502, 503]) { await activateFault({ stateDir, capability, scenario: `status_${status}` as never, ttlMs: 1_000 }); assert.deepEqual(await request(proxyPort, '/api/v2/health'), { kind: 'response', status: 200, body: '{"upstream":true}' }); assert.deepEqual(await request(proxyPort, '/v2/auth/refresh'), { kind: 'response', status, body: '' }); assert.deepEqual(await request(proxyPort, '/v2/auth/refresh'), { kind: 'response', status: 200, body: '{"upstream":true}' }); }
    await activateFault({ stateDir, capability, scenario: 'offline', ttlMs: 1_000 }); assert.deepEqual(await request(proxyPort, '/v2/auth/refresh'), { kind: 'lost' });
    await activateFault({ stateDir, capability, scenario: 'timeout', ttlMs: 1_000 }); const started = Date.now(); assert.deepEqual(await request(proxyPort, '/v2/auth/refresh'), { kind: 'response', status: 504, body: '' }); assert.ok(Date.now() - started >= 50 && Date.now() - started < 1_000);
  } finally { await Promise.all([new Promise<void>((resolve) => proxy.close(() => resolve())), new Promise<void>((resolve) => upstream.close(() => resolve()))]); await fs.rm(stateDir, { recursive: true, force: true }); }
});

test('fault proxy loses one refresh response only after upstream completion', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webtopup-fault-proxy-'));
  const capability = 'synthetic-local-capability';
  await fs.mkdir(path.join(stateDir, 'env'), { recursive: true });
  await fs.writeFile(path.join(stateDir, 'env', 'shared.env'), 'LOCAL_DEV_VERIFICATION=true\n');
  await fs.writeFile(path.join(stateDir, 'env', 'node.env'), `LOCAL_DESTRUCTIVE_CAPABILITY=${capability}\n`);
  let completed = 0;
  const upstream = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true }), () => { completed += 1; }); });
  const upstreamPort = await listen(upstream);
  const proxy = await startFaultProxy({ stateDir, upstreamOrigin: `http://127.0.0.1:${upstreamPort}`, host: '127.0.0.1', port: 0 });
  const proxyPort = (proxy.address() as { port: number }).port;
  try {
    const activationId = await activateFault({ stateDir, capability, scenario: 'refresh_response_loss_after_commit', ttlMs: 1_000 });
    assert.deepEqual(await request(proxyPort, '/api/v2/health'), { kind: 'response', status: 200, body: '{"ok":true}' });
    assert.deepEqual(await request(proxyPort, '/v2/auth/refresh', 'GET'), { kind: 'response', status: 200, body: '{"ok":true}' });
    assert.deepEqual(await request(proxyPort, '/v2/auth/refresh?unexpected=true'), { kind: 'response', status: 200, body: '{"ok":true}' });
    assert.deepEqual(await request(proxyPort, '/v2/auth/refresh'), { kind: 'lost' });
    assert.equal(completed, 4);
    let evidence = await readFaultEvidence(stateDir);
    for (let attempt = 0; attempt < 50 && !evidence; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      evidence = await readFaultEvidence(stateDir);
    }
    assert.deepEqual(evidence, {
      activationId, scenario: 'refresh_response_loss_after_commit', upstreamComplete: true, downstreamDestroyed: true, consumed: true,
    });
    assert.deepEqual(await request(proxyPort, '/v2/auth/refresh'), { kind: 'response', status: 200, body: '{"ok":true}' });
    assert.equal(completed, 5);
  } finally {
    await Promise.all([new Promise<void>((resolve) => proxy.close(() => resolve())), new Promise<void>((resolve) => upstream.close(() => resolve()))]);
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test('response-loss lease is preserved when upstream refresh does not succeed', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webtopup-fault-failed-upstream-')); const capability = 'synthetic-local-capability'; await fs.mkdir(path.join(stateDir, 'env'), { recursive: true }); await fs.writeFile(path.join(stateDir, 'env', 'shared.env'), 'LOCAL_DEV_VERIFICATION=true\n'); await fs.writeFile(path.join(stateDir, 'env', 'node.env'), `LOCAL_DESTRUCTIVE_CAPABILITY=${capability}\n`); let status = 500; const upstream = http.createServer((_req, res) => { res.writeHead(status); res.end('{}'); }); const upstreamPort = await listen(upstream); const proxy = await startFaultProxy({ stateDir, upstreamOrigin: `http://127.0.0.1:${upstreamPort}`, host: '127.0.0.1', port: 0 }); const proxyPort = (proxy.address() as { port: number }).port;
  try { await activateFault({ stateDir, capability, scenario: 'refresh_response_loss_after_commit', ttlMs: 1_000 }); assert.deepEqual(await request(proxyPort, '/v2/auth/refresh'), { kind: 'response', status: 500, body: '{}' }); assert.equal(await readFaultEvidence(stateDir), null); status = 200; assert.deepEqual(await request(proxyPort, '/v2/auth/refresh'), { kind: 'lost' }); }
  finally { await Promise.all([new Promise<void>((resolve) => proxy.close(() => resolve())), new Promise<void>((resolve) => upstream.close(() => resolve()))]); await fs.rm(stateDir, { recursive: true, force: true }); }
});

test('refresh race barrier releases exactly two queued requests together', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webtopup-fault-race-'));
  const capability = 'synthetic-local-capability';
  await fs.mkdir(path.join(stateDir, 'env'), { recursive: true });
  await fs.writeFile(path.join(stateDir, 'env', 'shared.env'), 'LOCAL_DEV_VERIFICATION=true\n');
  await fs.writeFile(path.join(stateDir, 'env', 'node.env'), `LOCAL_DESTRUCTIVE_CAPABILITY=${capability}\n`);
  let arrivals = 0;
  const upstream = http.createServer((_req, res) => { arrivals += 1; res.end(JSON.stringify({ arrival: arrivals })); });
  const upstreamPort = await listen(upstream);
  const proxy = await startFaultProxy({ stateDir, upstreamOrigin: `http://127.0.0.1:${upstreamPort}`, host: '127.0.0.1', port: 0 });
  const proxyPort = (proxy.address() as { port: number }).port;
  try {
    const activationId = await activateFault({ stateDir, capability, scenario: 'refresh_two_request_barrier', ttlMs: 1_000 });
    const first = request(proxyPort, '/v2/auth/refresh');
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(arrivals, 0);
    const results = await Promise.all([first, request(proxyPort, '/v2/auth/refresh')]);
    assert.equal(results.every((result) => result.kind === 'response'), true);
    assert.equal(arrivals, 2);
    let evidence = await readFaultEvidence(stateDir);
    for (let attempt = 0; attempt < 50 && !evidence; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      evidence = await readFaultEvidence(stateDir);
    }
    assert.deepEqual(evidence, { activationId, scenario: 'refresh_two_request_barrier', queued: 2, released: 2 });
  } finally {
    await Promise.all([new Promise<void>((resolve) => proxy.close(() => resolve())), new Promise<void>((resolve) => upstream.close(() => resolve()))]);
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test('refresh race barrier excludes a disconnected queued request', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webtopup-fault-race-disconnect-'));
  const capability = 'synthetic-local-capability';
  await fs.mkdir(path.join(stateDir, 'env'), { recursive: true });
  await fs.writeFile(path.join(stateDir, 'env', 'shared.env'), 'LOCAL_DEV_VERIFICATION=true\n');
  await fs.writeFile(path.join(stateDir, 'env', 'node.env'), `LOCAL_DESTRUCTIVE_CAPABILITY=${capability}\n`);
  let arrivals = 0;
  const upstream = http.createServer((_req, res) => { arrivals += 1; res.end('{}'); });
  const upstreamPort = await listen(upstream);
  const proxy = await startFaultProxy({ stateDir, upstreamOrigin: `http://127.0.0.1:${upstreamPort}`, host: '127.0.0.1', port: 0 });
  const proxyPort = (proxy.address() as { port: number }).port;
  try {
    await activateFault({ stateDir, capability, scenario: 'refresh_two_request_barrier', ttlMs: 1_000 });
    const abandoned = http.request({ host: '127.0.0.1', port: proxyPort, path: '/v2/auth/refresh', method: 'POST', headers: { 'content-type': 'application/json' } });
    abandoned.on('error', () => undefined);
    abandoned.end('{}');
    await new Promise((resolve) => setTimeout(resolve, 20));
    abandoned.destroy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(arrivals, 0);
    const firstLive = request(proxyPort, '/v2/auth/refresh');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(arrivals, 0);
    const results = await Promise.all([firstLive, request(proxyPort, '/v2/auth/refresh')]);
    assert.equal(results.every((result) => result.kind === 'response'), true);
    assert.equal(arrivals, 2);
  } finally {
    await Promise.all([new Promise<void>((resolve) => proxy.close(() => resolve())), new Promise<void>((resolve) => upstream.close(() => resolve()))]);
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test('barrier hook rejection releases queued requests and does not wedge later refreshes', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webtopup-fault-barrier-reject-')); const capability = 'synthetic-local-capability'; await fs.mkdir(path.join(stateDir, 'env'), { recursive: true }); await fs.writeFile(path.join(stateDir, 'env', 'shared.env'), 'LOCAL_DEV_VERIFICATION=true\n'); await fs.writeFile(path.join(stateDir, 'env', 'node.env'), `LOCAL_DESTRUCTIVE_CAPABILITY=${capability}\n`); const upstream = http.createServer((_req, res) => res.end('{}')); const upstreamPort = await listen(upstream); const proxy = await startFaultProxy({ stateDir, upstreamOrigin: `http://127.0.0.1:${upstreamPort}`, host: '127.0.0.1', port: 0, beforeBarrierConsume: async () => { throw new Error('synthetic barrier failure'); } }); const proxyPort = (proxy.address() as { port: number }).port;
  try { await activateFault({ stateDir, capability, scenario: 'refresh_two_request_barrier', ttlMs: 1_000 }); const results = await Promise.all([request(proxyPort, '/v2/auth/refresh'), request(proxyPort, '/v2/auth/refresh')]); assert.equal(results.every((value) => value.kind === 'response' && value.status === 503), true); assert.deepEqual(await request(proxyPort, '/api/v2/health'), { kind: 'response', status: 200, body: '{}' }); }
  finally { await Promise.all([new Promise<void>((resolve) => proxy.close(() => resolve())), new Promise<void>((resolve) => upstream.close(() => resolve()))]); await fs.rm(stateDir, { recursive: true, force: true }); }
});

test('proxy shutdown promptly destroys a parked barrier request', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webtopup-fault-close-')); const capability = 'synthetic-local-capability'; await fs.mkdir(path.join(stateDir, 'env'), { recursive: true }); await fs.writeFile(path.join(stateDir, 'env', 'shared.env'), 'LOCAL_DEV_VERIFICATION=true\n'); await fs.writeFile(path.join(stateDir, 'env', 'node.env'), `LOCAL_DESTRUCTIVE_CAPABILITY=${capability}\n`); const upstream = http.createServer((_req, res) => res.end('{}')); const upstreamPort = await listen(upstream); const proxy = await startFaultProxy({ stateDir, upstreamOrigin: `http://127.0.0.1:${upstreamPort}`, host: '127.0.0.1', port: 0 }); const proxyPort = (proxy.address() as { port: number }).port;
  try { await activateFault({ stateDir, capability, scenario: 'refresh_two_request_barrier', ttlMs: 1_000 }); const parked = request(proxyPort, '/v2/auth/refresh'); await new Promise((resolve) => setTimeout(resolve, 20)); const started = Date.now(); await new Promise<void>((resolve) => proxy.close(() => resolve())); assert.ok(Date.now() - started < 500); assert.deepEqual(await parked, { kind: 'lost' }); }
  finally { if (proxy.listening) await new Promise<void>((resolve) => proxy.close(() => resolve())); await new Promise<void>((resolve) => upstream.close(() => resolve())); await fs.rm(stateDir, { recursive: true, force: true }); }
});

test('refresh race barrier does not forward a pair disconnected during claim', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webtopup-fault-race-claim-disconnect-'));
  const capability = 'synthetic-local-capability';
  await fs.mkdir(path.join(stateDir, 'env'), { recursive: true });
  await fs.writeFile(path.join(stateDir, 'env', 'shared.env'), 'LOCAL_DEV_VERIFICATION=true\n');
  await fs.writeFile(path.join(stateDir, 'env', 'node.env'), `LOCAL_DESTRUCTIVE_CAPABILITY=${capability}\n`);
  let arrivals = 0;
  let releaseClaim!: () => void;
  const claimGate = new Promise<void>((resolve) => { releaseClaim = resolve; });
  const upstream = http.createServer((_req, res) => { arrivals += 1; res.end('{}'); });
  const upstreamPort = await listen(upstream);
  const proxy = await startFaultProxy({ stateDir, upstreamOrigin: `http://127.0.0.1:${upstreamPort}`, host: '127.0.0.1', port: 0, beforeBarrierConsume: () => claimGate });
  const proxyPort = (proxy.address() as { port: number }).port;
  try {
    await activateFault({ stateDir, capability, scenario: 'refresh_two_request_barrier', ttlMs: 1_000 });
    const first = http.request({ host: '127.0.0.1', port: proxyPort, path: '/v2/auth/refresh', method: 'POST' });
    const second = http.request({ host: '127.0.0.1', port: proxyPort, path: '/v2/auth/refresh', method: 'POST' });
    first.on('error', () => undefined); second.on('error', () => undefined);
    first.end('{}'); second.end('{}');
    await new Promise((resolve) => setTimeout(resolve, 20));
    first.destroy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseClaim();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(arrivals, 0);
    assert.equal(await readFaultEvidence(stateDir), null);
    second.destroy();
  } finally {
    await Promise.all([new Promise<void>((resolve) => proxy.close(() => resolve())), new Promise<void>((resolve) => upstream.close(() => resolve()))]);
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test('non-target upstream abort closes the downstream response', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webtopup-fault-abort-'));
  await fs.mkdir(path.join(stateDir, 'env'), { recursive: true });
  const upstream = http.createServer((_req, res) => { res.writeHead(200); res.flushHeaders(); res.write('partial'); setTimeout(() => res.socket?.destroy(), 5); });
  const upstreamPort = await listen(upstream);
  const proxy = await startFaultProxy({ stateDir, upstreamOrigin: `http://127.0.0.1:${upstreamPort}`, host: '127.0.0.1', port: 0 });
  try {
    assert.deepEqual(await request((proxy.address() as { port: number }).port, '/api/v2/health'), { kind: 'lost' });
  } finally {
    await Promise.all([new Promise<void>((resolve) => proxy.close(() => resolve())), new Promise<void>((resolve) => upstream.close(() => resolve()))]);
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test('oversized targeted response fails closed without consuming the lease', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webtopup-fault-size-'));
  const capability = 'synthetic-local-capability';
  await fs.mkdir(path.join(stateDir, 'env'), { recursive: true });
  await fs.writeFile(path.join(stateDir, 'env', 'shared.env'), 'LOCAL_DEV_VERIFICATION=true\n');
  await fs.writeFile(path.join(stateDir, 'env', 'node.env'), `LOCAL_DESTRUCTIVE_CAPABILITY=${capability}\n`);
  let oversized = true;
  const upstream = http.createServer((_req, res) => res.end(oversized ? Buffer.alloc(MAX_TARGET_RESPONSE_BYTES + 1) : '{"ok":true}'));
  const upstreamPort = await listen(upstream);
  const proxy = await startFaultProxy({ stateDir, upstreamOrigin: `http://127.0.0.1:${upstreamPort}`, host: '127.0.0.1', port: 0 });
  const proxyPort = (proxy.address() as { port: number }).port;
  try {
    await activateFault({ stateDir, capability, scenario: 'refresh_response_loss_after_commit', ttlMs: 1_000 });
    const result = await request(proxyPort, '/v2/auth/refresh');
    assert.equal(result.kind, 'response');
    if (result.kind === 'response') assert.equal(result.status, 502);
    assert.equal(await readFaultEvidence(stateDir), null);
    oversized = false;
    assert.deepEqual(await request(proxyPort, '/v2/auth/refresh'), { kind: 'lost' });
    for (let attempt = 0; attempt < 50 && !await readFaultEvidence(stateDir); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(await readFaultEvidence(stateDir));
  } finally {
    await Promise.all([new Promise<void>((resolve) => proxy.close(() => resolve())), new Promise<void>((resolve) => upstream.close(() => resolve()))]);
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test('site config fault inventory is closed and response-loss is PUT-only after 2xx', async () => {
  const { FAULT_SCENARIOS, SITE_CONFIG_RUST_FAULT_SCENARIOS } = await import('../faults.ts');
  assert.ok(FAULT_SCENARIOS.includes('site_config_response_loss_after_commit'));
  assert.deepEqual([...SITE_CONFIG_RUST_FAULT_SCENARIOS].sort(), [
    'site_config_claim_undo_mismatch',
    'site_config_commit_unknown_unresolved',
    'site_config_transaction_probe_unavailable',
    'site_config_transaction_start_unavailable',
  ]);
  for (const scenario of SITE_CONFIG_RUST_FAULT_SCENARIOS) {
    assert.ok(FAULT_SCENARIOS.includes(scenario));
  }

  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webtopup-site-config-fault-'));
  const capability = 'synthetic-local-capability';
  await fs.mkdir(path.join(stateDir, 'env'), { recursive: true });
  await fs.writeFile(path.join(stateDir, 'env', 'shared.env'), 'LOCAL_DEV_VERIFICATION=true\n');
  await fs.writeFile(path.join(stateDir, 'env', 'node.env'), `LOCAL_DESTRUCTIVE_CAPABILITY=${capability}\n`);
  let completed = 0;
  const upstream = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true }), () => { completed += 1; }); });
  const upstreamPort = await listen(upstream);
  const proxy = await startFaultProxy({ stateDir, upstreamOrigin: `http://127.0.0.1:${upstreamPort}`, host: '127.0.0.1', port: 0 });
  const proxyPort = (proxy.address() as { port: number }).port;
  try {
    const activationId = await activateFault({ stateDir, capability, scenario: 'site_config_response_loss_after_commit', ttlMs: 1_000 });
    assert.deepEqual(await request(proxyPort, '/v2/settings/admin/update', 'GET'), { kind: 'response', status: 200, body: '{"ok":true}' });
    assert.deepEqual(await request(proxyPort, '/v2/auth/refresh'), { kind: 'response', status: 200, body: '{"ok":true}' });
    assert.deepEqual(await request(proxyPort, '/v2/settings/admin/update', 'PUT'), { kind: 'lost' });
    assert.equal(completed, 3);
    let evidence = await readFaultEvidence(stateDir);
    for (let attempt = 0; attempt < 50 && !evidence; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      evidence = await readFaultEvidence(stateDir);
    }
    assert.deepEqual(evidence, {
      activationId,
      scenario: 'site_config_response_loss_after_commit',
      upstreamComplete: true,
      downstreamDestroyed: true,
      consumed: true,
    });
    const serialized = JSON.stringify(evidence);
    assert.doesNotMatch(serialized, /password|token|secret|cookie|otp|authorization|idempotency|MONGO_URI/i);
    assert.deepEqual(await request(proxyPort, '/v2/settings/admin/update', 'PUT'), { kind: 'response', status: 200, body: '{"ok":true}' });

    await activateFault({ stateDir, capability, scenario: 'site_config_transaction_probe_unavailable', ttlMs: 1_000 });
    assert.deepEqual(await request(proxyPort, '/v2/settings/admin/update', 'PUT'), { kind: 'response', status: 200, body: '{"ok":true}' });
    assert.equal(await readFaultEvidence(stateDir), null);
  } finally {
    await Promise.all([new Promise<void>((resolve) => proxy.close(() => resolve())), new Promise<void>((resolve) => upstream.close(() => resolve()))]);
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});
