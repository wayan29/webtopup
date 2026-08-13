import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { MongoClient } from 'mongodb';
import { loginFixture } from '../e2e/fixtures.ts';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const stateDir = path.join(root, '.dev-verification');

type Env = Record<string, string>;

test('upload security rejects spoofed content and accepts canonical images through Node', async () => {
  const [shared] = await Promise.all([
    readEnv(path.join(stateDir, 'env', 'shared.env')),
  ]);
  assert.equal(shared.LOCAL_DEV_VERIFICATION, 'true');
  assert.equal(shared.MONGO_DB, 'webtopup_task14_dev');

  const manager = await loginFixture('site-config-manager');
  const nodeBase = `http://127.0.0.1:${shared.NODE_PORT}`;
  const mongo = new MongoClient(shared.MONGO_URI);
  let accessToken = '';
  let csrf = '';
  const cookies: string[] = [];

  try {
    await mongo.connect();
    const db = mongo.db(shared.MONGO_DB);
    assert.ok(await db.collection('__localVerification').findOne({
      kind: 'webtopup-local-dev-verification',
      databaseName: 'webtopup_task14_dev',
    }));

    const login = await fetch(`${nodeBase}/api/v2${manager.loginEndpoint}`, {
      method: 'POST',
      headers: {
        Origin: shared.PUBLIC_ORIGIN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: manager.email,
        password: manager.password,
        rememberMe: false,
        deviceName: 'Task14 upload security',
      }),
    });
    // Manager has 2FA; login may require challenge. Fall back to site-config denied? No: use staff without challenge path if present.
    // Prefer catalog-manager (no 2FA) which has manageProducts for icons folder.
  } finally {
    await mongo.close().catch(() => undefined);
  }

  // Use catalog-manager (manageProducts, no 2FA) for folder permission mapping icons.
  const uploader = await loginFixture('catalog-manager');
  const login = await fetch(`${nodeBase}/api/v2${uploader.loginEndpoint}`, {
    method: 'POST',
    headers: {
      Origin: shared.PUBLIC_ORIGIN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: uploader.email,
      password: uploader.password,
      rememberMe: false,
      deviceName: 'Task14 upload security',
    }),
  });
  const loginBody = await login.json() as any;
  assert.equal(login.status, 200, JSON.stringify(loginBody));
  accessToken = String(loginBody.accessToken || '');
  assert.ok(accessToken.length > 10);
  const setCookie = login.headers.getSetCookie?.() || [];
  for (const value of setCookie) cookies.push(value.split(';')[0]!);
  csrf = cookies.find((value) => value.startsWith('csrf='))?.slice(5) || '';

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Origin: shared.PUBLIC_ORIGIN,
    Cookie: cookies.join('; '),
    ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
  };

  // Spoofed text as PNG.
  const spoof = await multipartUpload(`${nodeBase}/api/v2/upload?type=icons`, headers, 'spoof.png', 'image/png', Buffer.from('not-an-image'));
  assert.equal(spoof.status, 400);
  assert.equal(spoof.body?.error?.code || spoof.body?.code, 'UNSUPPORTED_IMAGE_FORMAT');

  // GIF signature.
  const gif = await multipartUpload(`${nodeBase}/api/v2/upload?type=icons`, headers, 'x.gif', 'image/gif', Buffer.from('GIF89a'));
  assert.equal(gif.status, 400);

  // Valid tiny PNG (1x1).
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const ok = await multipartUpload(`${nodeBase}/api/v2/upload?type=icons`, headers, 'ok.png', 'image/png', png);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body?.success, true);
  assert.match(String(ok.body?.filename || ''), /\.png$/i);
  assert.match(String(ok.body?.url || ''), /^\/uploads\/icons\//);

  // Cleanup uploaded file if present.
  if (ok.body?.filename) {
    await fetch(`${nodeBase}/api/v2/upload?type=icons&filename=${encodeURIComponent(ok.body.filename)}`, {
      method: 'DELETE',
      headers,
    }).catch(() => undefined);
  }
});

async function readEnv(file: string): Promise<Env> {
  return Object.fromEntries((await fs.readFile(file, 'utf8')).split(/\r?\n/u).filter(Boolean).map((line) => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

async function multipartUpload(
  url: string,
  headers: Record<string, string>,
  filename: string,
  contentType: string,
  bytes: Buffer,
): Promise<{ status: number; body: any }> {
  const boundary = `----task14${Date.now()}`;
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([prefix, bytes, suffix]);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });
  const text = await response.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: response.status, body: parsed };
}
