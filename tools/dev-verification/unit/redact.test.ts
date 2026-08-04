import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertNoSecrets, redact, writeEvidenceAtomic } from '../redact.ts';

test('recursively redacts secret-bearing keys while preserving bounded evidence', () => {
  const input = {
    requestId: 'req-123', actorId: 'actor-42', statusCode: 200, timestamp: '2026-07-18T00:00:00.000Z',
    nested: {
      Authorization: 'Bearer synthetic-access-value', cookie: 'sid=synthetic', 'Set-Cookie': 'refresh=synthetic',
      password: 'synthetic-password', jwt: 'a.b.c', refreshToken: 'synthetic-refresh', recovery_code: 'synthetic-recovery',
      csrfToken: 'synthetic-csrf', otp: '123456', clientSecret: 'synthetic-secret', digest: 'deadbeef',
      ciphertext: 'synthetic-ciphertext', nonce: 'synthetic-nonce',
    },
  };
  const output = redact(input) as typeof input;
  assert.equal(output.requestId, input.requestId);
  assert.equal(output.actorId, input.actorId);
  assert.equal(output.statusCode, 200);
  assert.equal(output.timestamp, input.timestamp);
  for (const value of Object.values(output.nested)) assert.equal(value, '[REDACTED]');
});

test('redacts secret patterns embedded in free text and arrays', () => {
  const output = redact([
    'Authorization: Bearer synthetic-bearer',
    'Cookie: sid=synthetic-cookie; csrf=synthetic-csrf',
    'mongodb://user:synthetic-password@127.0.0.1:27018/db?authSource=admin',
    'password=synthetic-password token=synthetic-token nonce=synthetic-nonce',
    '-----BEGIN PRIVATE KEY-----\nsynthetic-key\n-----END PRIVATE KEY-----',
  ]) as string[];
  assert.equal(output.every((value) => !value.includes('synthetic')), true);
  assert.equal(output.every((value) => value.includes('[REDACTED]')), true);
});

test('secret scanner rejects unsafe text without echoing offending content', () => {
  assert.doesNotThrow(() => assertNoSecrets(JSON.stringify({ requestId: 'req-123', statusCode: 204 })));
  assert.throws(() => assertNoSecrets('Authorization: Bearer synthetic-canary'), /^Error: evidence contains prohibited secret material$/);
  assert.throws(() => assertNoSecrets('{"nested":{"password":"synthetic-canary"}}'), /^Error: evidence contains prohibited secret material$/);
});

test('evidence writer rejects secrets introduced by toJSON serialization', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-verify-tojson-'));
  const destination = path.join(directory, 'report.json');
  const result = await writeEvidenceAtomic(destination, { toJSON: () => ({ password: 'synthetic-canary' }) });
  assert.equal(result, 'LOCAL DEV FAILED');
  await assert.rejects(() => fs.access(destination), { code: 'ENOENT' });
});

test('atomic evidence rejection preserves an existing last-known-good report', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-verify-existing-'));
  const destination = path.join(directory, 'report.json');
  await fs.writeFile(destination, '{"result":"NOT RUN"}\n', { mode: 0o600 });
  const result = await writeEvidenceAtomic(destination, { password: 'synthetic-canary' });
  assert.equal(result, 'LOCAL DEV FAILED');
  assert.equal(await fs.readFile(destination, 'utf8'), '{"result":"NOT RUN"}\n');
});

test('atomic evidence writer removes temporary and destination files on secrecy rejection', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-verify-redact-'));
  const destination = path.join(directory, 'report.json');
  const result = await writeEvidenceAtomic(destination, { status: 'LOCAL DEV VERIFIED', nested: { password: 'synthetic-canary' } });
  assert.equal(result, 'LOCAL DEV FAILED');
  await assert.rejects(() => fs.access(destination), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(directory), []);
});
