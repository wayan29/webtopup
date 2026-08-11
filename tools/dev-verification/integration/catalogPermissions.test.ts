import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { MongoClient, ObjectId } from 'mongodb';
import { loginFixture, type FixtureLogin } from '../e2e/fixtures.ts';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const stateDir = path.join(root, '.dev-verification');

type Env = Record<string, string>;
type ManifestEntry = {
  alias: string;
  fixtureRunId: string;
  role: 'member' | 'cs' | 'admin' | 'owner';
};
type JsonResult = { status: number; body: unknown };

test('catalog viewer reads through Node and Rust while writes stay permission-gated', async () => {
  const [shared, nodeSecrets, manifest, viewer, manager] = await Promise.all([
    readEnv(path.join(stateDir, 'env', 'shared.env')),
    readEnv(path.join(stateDir, 'env', 'node.env')),
    fs.readFile(path.join(stateDir, 'fixture-manifest.json'), 'utf8').then((value) => JSON.parse(value) as ManifestEntry[]),
    loginFixture('catalog-viewer'),
    loginFixture('catalog-manager'),
  ]);

  assert.equal(shared.LOCAL_DEV_VERIFICATION, 'true');
  assert.equal(shared.MONGO_DB, 'webtopup_task14_dev');
  assert.match(shared.MONGO_URI, /replicaSet=rs0/u);
  assert.equal(typeof shared.PUBLIC_ORIGIN, 'string');
  assert.equal(typeof nodeSecrets.API_V2_PROXY_SECRET, 'string');
  assert.ok((nodeSecrets.API_V2_PROXY_SECRET ?? '').length >= 32);

  const viewerManifest = manifest.find(({ alias }) => alias === 'catalog-viewer');
  const managerManifest = manifest.find(({ alias }) => alias === 'catalog-manager');
  assert.equal(viewerManifest?.role, 'cs');
  assert.equal(managerManifest?.role, 'cs');
  assert.equal(viewerManifest?.fixtureRunId, managerManifest?.fixtureRunId);

  const mongo = new MongoClient(shared.MONGO_URI);
  const fixtureIds: ObjectId[] = [];
  let safeToCleanup = false;
  let primary: unknown = null;
  const cleanupErrors: unknown[] = [];

  try {
    await mongo.connect();
    const db = mongo.db(shared.MONGO_DB);
    const marker = await db.collection('__localVerification').findOne({
      kind: 'webtopup-local-dev-verification',
      databaseName: 'webtopup_task14_dev',
    });
    assert.ok(marker);
    safeToCleanup = true;

    const users = db.collection('users');
    const [viewerRow, managerRow] = await Promise.all([
      users.findOne(
        { email: viewer.email, task14Fixture: true, fixtureRunId: viewerManifest?.fixtureRunId },
        { projection: { _id: 1, role: 1, active: 1, email: 1 } },
      ),
      users.findOne(
        { email: manager.email, task14Fixture: true, fixtureRunId: managerManifest?.fixtureRunId },
        { projection: { _id: 1, role: 1, active: 1, email: 1 } },
      ),
    ]);
    assert.ok(viewerRow && managerRow);
    assert.equal(viewerRow.role, 'cs');
    assert.equal(managerRow.role, 'cs');
    assert.notEqual(viewerRow.active, false);
    assert.notEqual(managerRow.active, false);
    fixtureIds.push(viewerRow._id, managerRow._id);

    const nodeBase = `http://127.0.0.1:${shared.NODE_PORT}`;
    const rustBase = `http://127.0.0.1:${shared.RUST_PORT}`;
    const viewerAccessToken = await loginAtGateway(nodeBase, viewer, shared.PUBLIC_ORIGIN);
    const managerAccessToken = await loginAtGateway(nodeBase, manager, shared.PUBLIC_ORIGIN);
    const viewerGatewayHeaders = bearerHeaders(viewerAccessToken, shared.PUBLIC_ORIGIN);
    const managerGatewayHeaders = bearerHeaders(managerAccessToken, shared.PUBLIC_ORIGIN);

    for (const route of [
      '/api/v2/products/admin/all',
      '/api/v2/categories/admin/all',
      '/api/v2/operators/admin/all',
      '/api/v2/product-types/admin/all',
    ]) {
      const response = await jsonRequest(`${nodeBase}${route}`, {
        method: 'GET',
        headers: viewerGatewayHeaders,
      });
      assertStatus(response, 200, `Node catalog read ${route}`);
    }

    for (const request of [
      { method: 'POST', route: '/api/v2/categories/admin/create', body: {} },
      { method: 'POST', route: '/api/v2/vendors/digiflazz/settings', body: {} },
      { method: 'POST', route: '/api/v2/vendors/digiflazz/pricelist/fetch', body: {} },
      { method: 'GET', route: '/api/v2/settings/admin/all' },
    ]) {
      const response = await jsonRequest(`${nodeBase}${request.route}`, {
        method: request.method,
        headers: viewerGatewayHeaders,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      });
      assertStatus(response, 403, `Node denied ${request.method} ${request.route}`);
      assert.equal(errorCode(response.body), 'PERMISSION_DENIED');
    }

    const categoryCountBeforeManager = await db.collection('categories').countDocuments({});
    const managerGatewayMutation = await jsonRequest(`${nodeBase}/api/v2/categories/admin/create`, {
      method: 'POST',
      headers: managerGatewayHeaders,
      body: JSON.stringify({}),
    });
    assertStatus(managerGatewayMutation, 400, 'Node manager invalid catalog mutation');

    const viewerTrustedHeaders = trustedHeaders(
      nodeSecrets.API_V2_PROXY_SECRET,
      viewerRow._id,
      viewerRow.email,
      viewerRow.role,
      shared.PUBLIC_ORIGIN,
    );
    const managerTrustedHeaders = trustedHeaders(
      nodeSecrets.API_V2_PROXY_SECRET,
      managerRow._id,
      managerRow.email,
      managerRow.role,
      shared.PUBLIC_ORIGIN,
    );

    for (const route of [
      '/v2/products/admin/all',
      '/v2/categories/admin/all',
      '/v2/operators/admin/all',
      '/v2/product-types/admin/all',
    ]) {
      const response = await jsonRequest(`${rustBase}${route}`, {
        method: 'GET',
        headers: viewerTrustedHeaders,
      });
      assertStatus(response, 200, `Rust catalog read ${route}`);
    }

    const viewerRustMutation = await jsonRequest(`${rustBase}/v2/categories/admin/create`, {
      method: 'POST',
      headers: viewerTrustedHeaders,
      body: JSON.stringify({}),
    });
    assertStatus(viewerRustMutation, 403, 'Rust viewer catalog mutation');

    const managerRustMutation = await jsonRequest(`${rustBase}/v2/categories/admin/create`, {
      method: 'POST',
      headers: managerTrustedHeaders,
      body: JSON.stringify({}),
    });
    assertStatus(managerRustMutation, 400, 'Rust manager invalid catalog mutation');

    const categoryCountAfterManager = await db.collection('categories').countDocuments({});
    assert.equal(categoryCountAfterManager, categoryCountBeforeManager);
  } catch (error) {
    primary = error;
  } finally {
    if (safeToCleanup && fixtureIds.length > 0) {
      try {
        const db = mongo.db(shared.MONGO_DB);
        await db.collection('authsessions').deleteMany({ userId: { $in: fixtureIds } });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await mongo.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (primary && cleanupErrors.length > 0) {
    throw new AggregateError([primary, ...cleanupErrors], 'catalog authorization verification and cleanup failed');
  }
  if (primary) throw primary;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'catalog authorization cleanup failed');
});

async function readEnv(file: string): Promise<Env> {
  return Object.fromEntries((await fs.readFile(file, 'utf8')).split(/\r?\n/u).filter(Boolean).map((line) => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

async function loginAtGateway(base: string, fixture: FixtureLogin, origin: string): Promise<string> {
  assert.equal(fixture.audience, 'staff');
  const response = await jsonRequest(`${base}/api/v2${fixture.loginEndpoint}`, {
    method: 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: fixture.email,
      password: fixture.password,
      rememberMe: false,
      deviceName: 'Task 14 catalog authorization',
    }),
  });
  assertStatus(response, 200, 'catalog fixture staff login');
  const accessToken = response.body && typeof response.body === 'object'
    ? (response.body as Record<string, unknown>).accessToken
    : undefined;
  assert.equal(typeof accessToken, 'string');
  assert.ok((accessToken as string).length > 0);
  return accessToken as string;
}

function bearerHeaders(accessToken: string, origin: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Origin: origin,
    'Content-Type': 'application/json',
  };
}

function trustedHeaders(
  secret: string | undefined,
  userId: ObjectId,
  email: string,
  role: string,
  origin: string,
): Record<string, string> {
  assert.equal(typeof secret, 'string');
  return {
    'x-api-v2-proxy-secret': secret as string,
    'x-webtopup-user-id': userId.toHexString(),
    'x-webtopup-user-role': role,
    'x-webtopup-user-email': email,
    Origin: origin,
    'Content-Type': 'application/json',
  };
}

async function jsonRequest(url: string, options: RequestInit): Promise<JsonResult> {
  const response = await fetch(url, options);
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

function assertStatus(response: JsonResult, expected: number, label: string): void {
  assert.equal(response.status, expected, label);
}

function errorCode(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  if (record.error && typeof record.error === 'object' && !Array.isArray(record.error)) {
    return (record.error as Record<string, unknown>).code;
  }
  return record.code;
}
