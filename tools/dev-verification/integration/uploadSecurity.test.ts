import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { MongoClient, ObjectId } from 'mongodb';
import { loginFixture } from '../e2e/fixtures.ts';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const stateDir = path.join(root, '.dev-verification');

type Env = Record<string, string>;

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('upload security rejects spoofed content and accepts canonical images through Node', async () => {
  const shared = await readEnv(path.join(stateDir, 'env', 'shared.env'));
  assert.equal(shared.LOCAL_DEV_VERIFICATION, 'true');
  assert.equal(shared.MONGO_DB, 'webtopup_task14_dev');

  const uploader = await loginFixture('catalog-manager');
  const nodeBase = `http://127.0.0.1:${shared.NODE_PORT}`;
  const mongo = new MongoClient(shared.MONGO_URI);
  const created: string[] = [];
  let productId: ObjectId | undefined;
  let primary: unknown = null;

  try {
    await mongo.connect();
    const db = mongo.db(shared.MONGO_DB);
    assert.ok(await db.collection('__localVerification').findOne({
      kind: 'webtopup-local-dev-verification',
      databaseName: 'webtopup_task14_dev',
    }));

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
    const accessToken = String(loginBody.accessToken || '');
    assert.ok(accessToken.length > 10);
    const cookies = (login.headers.getSetCookie?.() || []).map((value) => value.split(';')[0]!);
    const csrf = cookies.find((value) => value.startsWith('csrf='))?.slice(5) || '';
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      Origin: shared.PUBLIC_ORIGIN,
      Cookie: cookies.join('; '),
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
    };

    const spoof = await multipartUpload(`${nodeBase}/api/v2/upload?type=icons`, headers, 'spoof.png', 'image/png', Buffer.from('not-an-image'));
    assert.equal(spoof.status, 400);
    assert.equal(codeOf(spoof.body), 'UNSUPPORTED_IMAGE_FORMAT');

    const truncated = await multipartUpload(`${nodeBase}/api/v2/upload?type=icons`, headers, 'trunc.jpg', 'image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    assert.equal(truncated.status, 400);
    assert.ok(['INVALID_IMAGE_CONTENT', 'UNSUPPORTED_IMAGE_FORMAT'].includes(String(codeOf(truncated.body))));

    const gif = await multipartUpload(`${nodeBase}/api/v2/upload?type=icons`, headers, 'x.gif', 'image/gif', Buffer.from('GIF89a'));
    assert.equal(gif.status, 400);

    const ok = await multipartUpload(`${nodeBase}/api/v2/upload?type=icons`, headers, 'ok.png', 'image/png', PNG_1X1);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body?.success, true);
    assert.match(String(ok.body?.filename || ''), /\.png$/i);
    assert.match(String(ok.body?.url || ''), /^\/uploads\/icons\//);
    created.push(String(ok.body.filename));

    const canonicalUrl = String(ok.body.url);
    const managed = await db.collection('managedassets').findOne({ canonicalPath: canonicalUrl });
    assert.ok(managed, `managed asset row missing for ${canonicalUrl}`);
    assert.equal(managed.state, 'available');
    assert.equal(managed.referenceCount, 0);
    assert.equal(managed.folder, 'icons');
    assert.equal(managed.filename, ok.body.filename);
    assert.equal(managed.format, 'png');
    assert.equal(managed.width, 1);
    assert.equal(managed.height, 1);
    const uploadPath = path.join(root, 'uploads', 'icons', String(ok.body.filename));
    const publishedBytes = await fs.readFile(uploadPath);
    assert.ok(publishedBytes.length > 0);
    assert.equal(managed.size, publishedBytes.length);

    const batch = await multipartBatch(`${nodeBase}/api/v2/upload/multiple?type=icons`, headers, [
      { filename: 'ok2.png', contentType: 'image/png', bytes: PNG_1X1 },
      { filename: 'bad.png', contentType: 'image/png', bytes: Buffer.from('not-an-image') },
    ]);
    assert.equal(batch.status, 400);
    assert.ok(codeOf(batch.body));

    productId = new ObjectId();
    await db.collection('products').insertOne({
      _id: productId,
      code: `UPL-${productId.toHexString().slice(-6)}`,
      name: 'Task14 referenced upload',
      status: true,
      icon: ok.body.url,
      price: { basic: 1000, gold: 1000, platinum: 1000 },
      task14Fixture: true,
    });
    const blocked = await fetch(`${nodeBase}/api/v2/upload?type=icons&filename=${encodeURIComponent(ok.body.filename)}`, {
      method: 'DELETE',
      headers,
    });
    const blockedBody = await blocked.json().catch(() => ({}));
    assert.equal(blocked.status, 409);
    assert.equal(codeOf(blockedBody), 'ASSET_IN_USE');

    await db.collection('products').deleteOne({ _id: productId });
    const deleted = await fetch(`${nodeBase}/api/v2/upload?type=icons&filename=${encodeURIComponent(ok.body.filename)}`, {
      method: 'DELETE',
      headers,
    });
    assert.ok(deleted.status === 200 || deleted.status === 204);

    const manager = await loginFixture('site-config-manager');
    const staffLogin = await fetch(`${nodeBase}/api/v2${manager.loginEndpoint}`, {
      method: 'POST',
      headers: { Origin: shared.PUBLIC_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: manager.email,
        password: manager.password,
        rememberMe: false,
        deviceName: 'Task14 upload missing asset',
      }),
    });
    assert.notEqual(staffLogin.status, 500);
  } catch (error) {
    primary = error;
  } finally {
    try {
      if (productId) await mongo.db(shared.MONGO_DB).collection('products').deleteOne({ _id: productId });
    } catch { /* ignore */ }
    await mongo.close().catch(() => undefined);
  }
  if (primary) throw primary;
});

async function readEnv(file: string): Promise<Env> {
  return Object.fromEntries((await fs.readFile(file, 'utf8')).split(/\r?\n/u).filter(Boolean).map((line) => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

function codeOf(body: any): unknown {
  return body?.error?.code ?? body?.code;
}

async function multipartUpload(
  url: string,
  headers: Record<string, string>,
  filename: string,
  contentType: string,
  bytes: Buffer,
): Promise<{ status: number; body: any }> {
  return multipartBatch(url, headers, [{ filename, contentType, bytes }]);
}

async function multipartBatch(
  url: string,
  headers: Record<string, string>,
  files: Array<{ filename: string; contentType: string; bytes: Buffer }>,
): Promise<{ status: number; body: any }> {
  const boundary = `----task14${Date.now()}`;
  const parts: Buffer[] = [];
  for (const file of files) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
    ));
    parts.push(file.bytes);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body: Buffer.concat(parts),
  });
  const text = await response.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: response.status, body: parsed };
}
