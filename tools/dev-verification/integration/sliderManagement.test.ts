import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { fixtureOtp, loginFixture } from '../e2e/fixtures.ts';
import {
  activateFault,
  consumeFault,
  FAULT_SCENARIOS,
  readFaultEvidence,
  SLIDER_RUST_FAULT_SCENARIOS,
  withFault,
} from '../faults.ts';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const stateDir = path.join(root, '.dev-verification');
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

type Env = Record<string, string>;
type JsonResult = { status: number; body: any; headers: Headers; text: string };
type Auth = { accessToken: string; headers: Record<string, string> };
type SyntheticRow = { collection: string; id: ObjectId };

const readEnv = async (file: string): Promise<Env> => Object.fromEntries(
  (await fs.readFile(file, 'utf8')).split(/\r?\n/u).filter(Boolean).map((line) => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }),
);

const codeOf = (body: any): string | undefined => body?.error?.code ?? body?.code;

async function jsonRequest(url: string, options: RequestInit = {}): Promise<JsonResult> {
  const response = await fetch(url, options);
  const text = await response.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body, headers: response.headers, text };
}

function bearer(accessToken: string, origin: string, cookies = ''): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Origin: origin,
    'Content-Type': 'application/json',
    ...(cookies ? { Cookie: cookies } : {}),
  };
}

function trusted(secret: string | undefined, user: { _id: ObjectId; email: string; role: string }, origin: string): Record<string, string> {
  assert.equal(typeof secret, 'string');
  return {
    'x-api-v2-proxy-secret': secret as string,
    'x-webtopup-user-id': user._id.toHexString(),
    'x-webtopup-user-role': user.role,
    'x-webtopup-user-email': user.email,
    Origin: origin,
    'Content-Type': 'application/json',
  };
}

async function loginAtGateway(
  nodeBase: string,
  origin: string,
  alias: string,
): Promise<Auth> {
  const fixture = await loginFixture(alias);
  const login = await jsonRequest(`${nodeBase}/api/v2${fixture.loginEndpoint}`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: fixture.email,
      password: fixture.password,
      rememberMe: false,
      deviceName: `Task16 ${alias}`,
    }),
  });
  assert.equal(login.status, 200, `${alias} login: ${login.text}`);
  const cookies = (login.headers.getSetCookie?.() || []).map((value) => value.split(';')[0]).join('; ');
  let payload = login.body as any;
  if (payload?.requiresTwoFactor === true) {
    const otp = await fixtureOtp(alias);
    const verify = await jsonRequest(`${nodeBase}/api/v2/auth/2fa/login-verify`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookies ? { Cookie: cookies } : {}) },
      body: JSON.stringify({ challengeToken: payload.challengeToken, code: otp }),
    });
    assert.equal(verify.status, 200, `${alias} 2FA login: ${verify.text}`);
    payload = verify.body;
  }
  assert.equal(typeof payload?.accessToken, 'string', `${alias} did not return an access token`);
  return {
    accessToken: payload.accessToken,
    headers: bearer(payload.accessToken, origin, cookies),
  };
}

async function multipartUpload(
  url: string,
  headers: Record<string, string>,
  filename: string,
  contentType: string,
  bytes: Buffer,
): Promise<JsonResult> {
  const boundary = `----task16${crypto.randomUUID().replaceAll('-', '')}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return jsonRequest(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
}

function syntheticKey(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

function sliderBody(expectedRevision: number, image: string, status = false, name = `Task16 ${crypto.randomUUID()}`): Record<string, unknown> {
  return {
    expectedRevision,
    slider: { name, image, link: '/task16', status },
  };
}

async function postJson(nodeBase: string, pathName: string, headers: Record<string, string>, body: Record<string, unknown>): Promise<JsonResult> {
  return jsonRequest(`${nodeBase}${pathName}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function putJson(nodeBase: string, pathName: string, headers: Record<string, string>, body: Record<string, unknown>): Promise<JsonResult> {
  return jsonRequest(`${nodeBase}${pathName}`, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function markSynthetic(db: Db, collection: string, id: ObjectId, fixtureRunId: string): Promise<void> {
  await db.collection(collection).updateOne({ _id: id }, { $set: { task16Fixture: true, fixtureRunId } });
}

async function stepUp(nodeBase: string, origin: string, manager: Auth, password: string, alias: string): Promise<string> {
  const otp = await fixtureOtp(alias);
  const response = await jsonRequest(`${nodeBase}/api/v2/auth/step-up`, {
    method: 'POST',
    headers: manager.headers,
    body: JSON.stringify({ password, otp, actionGroup: 'settings.sensitive' }),
  });
  assert.equal(response.status, 200, `step-up: ${response.text}`);
  assert.equal(typeof response.body?.grantToken, 'string');
  return response.body.grantToken;
}

async function waitForHost(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(750) });
    return response.status < 500;
  } catch { return false; }
}

test('slider management foundation proves disposable transaction matrix and required named subproofs', async (t) => {
  const [shared, nodeSecrets, manifest] = await Promise.all([
    readEnv(path.join(stateDir, 'env', 'shared.env')).catch(() => ({} as Env)),
    readEnv(path.join(stateDir, 'env', 'node.env')).catch(() => ({} as Env)),
    fs.readFile(path.join(stateDir, 'fixture-manifest.json'), 'utf8').then((text) => JSON.parse(text) as Array<{ alias: string; fixtureRunId: string }>).catch(() => []),
  ]);
  if (shared.LOCAL_DEV_VERIFICATION !== 'true' || shared.MONGO_DB !== 'webtopup_task14_dev') {
    t.skip('environment-blocked: exact disposable marker/database are unavailable');
    return;
  }
  const nodeBase = `http://127.0.0.1:${shared.NODE_PORT}`;
  const rustBase = `http://127.0.0.1:${shared.RUST_PORT}`;
  if (!(await waitForHost(`${nodeBase}/health`)) || !(await waitForHost(`${rustBase}/api/v2/health`))) {
    t.skip(`environment-blocked: disposable host is not ready (${nodeBase}, ${rustBase})`);
    return;
  }
  assert.equal(shared.MONGO_URI?.startsWith('mongodb://127.0.0.1:27018/webtopup_task14_dev?'), true);
  assert.match(shared.MONGO_URI, /replicaSet=rs0/u);
  assert.equal(shared.PROVIDER_MODE, 'mock');
  assert.ok(['slider-denied', 'slider-manager', 'slider-inactive'].every((alias) => manifest.some((item) => item.alias === alias)));
  const fixtureRunId = manifest.find((item) => item.alias === 'slider-manager')?.fixtureRunId;
  assert.equal(typeof fixtureRunId, 'string');
  const capability = nodeSecrets.LOCAL_DESTRUCTIVE_CAPABILITY;
  assert.equal(typeof capability, 'string');
  const runRustFault = async (
    scenario: (typeof SLIDER_RUST_FAULT_SCENARIOS)[number],
    invoke: () => Promise<JsonResult>,
  ): Promise<JsonResult> => {
    const result = await withFault({
      stateDir,
      capability: capability as string,
      scenario,
      ttlMs: 8_000,
    }, invoke);
    const evidence = await readFaultEvidence(stateDir);
    assert.equal(evidence?.scenario, scenario, `${scenario} evidence status=${result.status} body=${result.text}`);
    return result;
  };

  const mongo = new MongoClient(shared.MONGO_URI);
  const created: SyntheticRow[] = [];
  const uploadedPaths: string[] = [];
  const claimKeys: string[] = [];
  const auditIds: ObjectId[] = [];
  let managerAuth: Auth | undefined;
  let managerFixture: Awaited<ReturnType<typeof loginFixture>> | undefined;
  let managerRow: { _id: ObjectId; email: string; role: string } | undefined;
  let inactiveAuth: Auth | undefined;
  let primary: unknown = null;
  try {
    await mongo.connect();
    const db = mongo.db(shared.MONGO_DB);
    const marker = await db.collection('__localVerification').findOne({ kind: 'webtopup-local-dev-verification' }, { projection: { _id: 0 } });
    assert.deepEqual({ kind: marker?.kind, databaseName: marker?.databaseName }, { kind: 'webtopup-local-dev-verification', databaseName: 'webtopup_task14_dev' });
    const hello = await mongo.db('admin').command<any>({ hello: 1 });
    assert.equal(hello.setName, 'rs0');
    assert.equal(hello.isWritablePrimary, true);
    assert.equal(hello.me === '127.0.0.1:27018' || hello.me === 'localhost:27018', true);
    assert.equal(hello.hosts?.length, 1);

    // 2. Real synthetic identities; clear only marked fixture sessions so repeated local runs do
    // not turn the bounded device policy into an unrelated login failure. Inactive is logged in
    // before restoring its disabled status so the gateway can prove AUTH_ACCOUNT_DISABLED.
    const users = db.collection('users');
    for (const alias of ['slider-manager', 'slider-denied', 'slider-inactive', 'catalog-manager']) {
      const fixture = await loginFixture(alias);
      const user = await users.findOne({ email: fixture.email, task14Fixture: true }, { projection: { _id: 1 } });
      if (user) await db.collection('authsessions').deleteMany({ userId: user._id });
    }
    managerFixture = await loginFixture('slider-manager');
    const managerDoc = await users.findOne({ email: managerFixture.email, task14Fixture: true }, { projection: { _id: 1, email: 1, role: 1, active: 1, permissions: 1, twoFactorEnabled: 1, twoFactorSecret: 1 } });
    assert.ok(managerDoc);
    assert.equal(managerDoc.active, true);
    assert.equal(managerDoc.role, 'cs');
    assert.equal((managerDoc.permissions as any)?.manageSettings, true);
    assert.equal(managerDoc.twoFactorEnabled, true);
    assert.equal(typeof managerDoc.twoFactorSecret, 'string');
    managerRow = { _id: managerDoc._id, email: String(managerDoc.email), role: String(managerDoc.role) };
    managerAuth = await loginAtGateway(nodeBase, shared.PUBLIC_ORIGIN, 'slider-manager');
    const inactiveFixture = await loginFixture('slider-inactive');
    const inactiveDoc = await users.findOne({ email: inactiveFixture.email, task14Fixture: true }, { projection: { _id: 1, email: 1, role: 1, active: 1, permissions: 1, twoFactorEnabled: 1, twoFactorSecret: 1 } });
    assert.ok(inactiveDoc);
    assert.equal(inactiveDoc.active, false);
    assert.equal(inactiveDoc.twoFactorEnabled, true);
    assert.equal(typeof inactiveDoc.twoFactorSecret, 'string');
    await db.collection('authsessions').deleteMany({ userId: inactiveDoc._id });
    await users.updateOne({ _id: inactiveDoc._id }, { $set: { active: true } });
    try { inactiveAuth = await loginAtGateway(nodeBase, shared.PUBLIC_ORIGIN, 'slider-inactive'); }
    finally { await users.updateOne({ _id: inactiveDoc._id }, { $set: { active: false } }); }

    // 3. The real upload pipeline supplies canonical managed cover assets, never synthetic paths.
    const cover = await multipartUpload(`${nodeBase}/api/v2/upload?type=covers`, managerAuth.headers, `task16-${crypto.randomUUID()}.png`, 'image/png', PNG_1X1);
    assert.equal(cover.status, 200, cover.text);
    assert.equal(cover.body?.success, true);
    const image = String(cover.body.url);
    assert.match(image, /^\/uploads\/covers\/\d+-[a-f0-9]+\.png$/u);
    uploadedPaths.push(image);
    const asset = await db.collection('managedassets').findOne({ canonicalPath: image });
    assert.ok(asset);
    assert.equal(asset.state, 'available');
    assert.equal(asset.referenceCount, 0);
    await db.collection('managedassets').updateOne({ _id: asset._id }, { $set: { task16Fixture: true, fixtureRunId } });
    created.push({ collection: 'managedassets', id: asset._id });

    const catalogAuth = await loginAtGateway(nodeBase, shared.PUBLIC_ORIGIN, 'catalog-manager');

    // 4. Real legacy cover-writer fence proof. Each writer receives a marked prerequisite row,
    // persists the same canonical cover through its actual Node route, and must increment only
    // this asset's monotonic acquisition fence while leaving the durable domain row in place.
    const categoryId = new ObjectId();
    const operatorId = new ObjectId();
    await db.collection('categories').insertOne({ _id: categoryId, name: `Task16 category ${crypto.randomUUID()}`, slug: `task16-${crypto.randomUUID()}`, icon: '', sortOrder: 0, status: true, task16Fixture: true, fixtureRunId });
    await db.collection('operators').insertOne({ _id: operatorId, name: `Task16 operator ${crypto.randomUUID()}`, slug: `task16-${crypto.randomUUID()}`, categoryId, icon: '', sortOrder: 0, status: true, task16Fixture: true, fixtureRunId });
    created.push({ collection: 'categories', id: categoryId }, { collection: 'operators', id: operatorId });
    const writerFence = async (collection: string, field: string, route: string, headers: Record<string, string>, body: Record<string, unknown>, responseStatus = 201) => {
      const before = await db.collection('managedassets').findOne({ _id: asset._id }, { projection: { acquisitionFenceVersion: 1 } });
      const prior = await db.collection(collection).findOne({ task16Fixture: true, fixtureRunId, [field]: { $exists: true } }, { projection: { _id: 1 } });
      const result = await postJson(nodeBase, route, headers, body);
      assert.equal(result.status, responseStatus, `${collection}.${field}: ${result.text}`);
      const after = await db.collection('managedassets').findOne({ _id: asset._id }, { projection: { acquisitionFenceVersion: 1 } });
      assert.equal(Number(after?.acquisitionFenceVersion), Number(before?.acquisitionFenceVersion ?? 0) + 1, `${collection}.${field} acquisition fence`);
      const insertedId = new ObjectId(String(result.body?._id ?? result.body?.productType?._id ?? result.body?.flashSale?._id ?? result.body?.reward?._id));
      assert.ok(insertedId, `${collection}.${field} durable row`);
      const row = await db.collection(collection).findOne({ _id: insertedId });
      assert.ok(row, `${collection}.${field} durable reference`);
      assert.equal(row?.[field], image, `${collection}.${field} path`);
      await markSynthetic(db, collection, insertedId, fixtureRunId);
      created.push({ collection, id: insertedId });
      assert.equal(prior, null, `${collection}.${field} uses a new synthetic row`);
    };
    await writerFence('producttypes', 'cover', '/api/v2/product-types/admin/create', catalogAuth.headers, {
      name: `Task16 product type ${crypto.randomUUID()}`, categoryId: categoryId.toHexString(), operatorId: operatorId.toHexString(), icon: '', cover: image,
      openTime: '00:00', closeTime: '23:59', open24Hours: true, estimatedDelivery: '', processType: 'auto', status: false,
    });
    await writerFence('flashsales', 'banner', '/api/v2/flash-sales/admin/create', catalogAuth.headers, {
      name: `Task16 flash ${crypto.randomUUID()}`, description: 'Task16', startDate: '2099-01-01T00:00:00Z', endDate: '2099-01-02T00:00:00Z', products: [], isActive: false, banner: image,
    });
    await writerFence('articles', 'image', '/api/v2/articles', managerAuth.headers, {
      title: `Task16 article ${crypto.randomUUID()}`, excerpt: 'Task16 excerpt', content: '<p>Task16 content</p>', image, category: 'Task16', status: 'draft',
    });
    await writerFence('rewards', 'imageUrl', '/api/v2/rewards/admin/create', catalogAuth.headers, {
      name: `Task16 reward ${crypto.randomUUID()}`, description: 'Task16 reward', pointsRequired: 1, stock: 1, imageUrl: image, category: 'Task16', status: false,
    });
    assert.equal(await db.collection('managedassets').findOne({ _id: asset._id }).then((row) => row?.state), 'available', 'covers-writer-fence');

    // 5. Table-driven gateway matrix. Invalid mutation payloads deliberately use a valid
    // permission context, proving they reached Rust rather than being rejected by Node.
    const anonymousRoutes = ['/api/v2/sliders/admin/all', '/api/v2/sliders/admin/archived'];
    for (const route of anonymousRoutes) {
      const result = await jsonRequest(`${nodeBase}${route}`);
      assert.equal(result.status, 401, route);
      assert.equal(codeOf(result.body), 'AUTH_TOKEN_INVALID');
    }
    const deniedAuth = await loginAtGateway(nodeBase, shared.PUBLIC_ORIGIN, 'slider-denied');
    const deniedFixture = await loginFixture('slider-denied');
    const deniedDoc = await users.findOne({ email: deniedFixture.email, task14Fixture: true }, { projection: { _id: 1, email: 1, role: 1, active: 1 } });
    assert.ok(deniedDoc);
    assert.equal(deniedDoc.active, true);
    const inactiveHeaders = inactiveAuth?.headers;
    assert.ok(inactiveHeaders);
    const mutationCases = [
      { method: 'POST', path: '/api/v2/sliders/admin/create', body: sliderBody(0, image) },
      { method: 'PUT', path: '/api/v2/sliders/admin/not-an-object-id', body: { expectedRevision: 0, changes: { name: 'invalid' } } },
      { method: 'POST', path: '/api/v2/sliders/admin/not-an-object-id/archive', body: { expectedRevision: 0 } },
      { method: 'POST', path: '/api/v2/sliders/admin/not-an-object-id/restore', body: { expectedRevision: 0 } },
      { method: 'PUT', path: '/api/v2/sliders/admin/reorder', body: { expectedRevision: 0, orders: [] } },
    ] as const;
    for (const matrixActor of [
      { name: 'denied', headers: deniedAuth.headers, status: 403, code: 'PERMISSION_DENIED' },
      { name: 'inactive', headers: inactiveHeaders, status: 403, code: 'AUTH_ACCOUNT_DISABLED' },
    ]) {
      for (const route of ['/api/v2/sliders/admin/all', '/api/v2/sliders/admin/archived']) {
        const result = await jsonRequest(`${nodeBase}${route}`, { headers: matrixActor.headers });
        assert.equal(result.status, matrixActor.status, `${matrixActor.name} ${route}`);
        assert.equal(codeOf(result.body), matrixActor.code);
      }
      for (const mutation of mutationCases) {
        const result = await jsonRequest(`${nodeBase}${mutation.path}`, {
          method: mutation.method,
          headers: { ...matrixActor.headers, 'Idempotency-Key': syntheticKey('task16_matrix') },
          body: JSON.stringify(mutation.body),
        });
        assert.equal(result.status, matrixActor.status, `${matrixActor.name} ${mutation.path}`);
        assert.equal(codeOf(result.body), matrixActor.code);
      }
    }
    const hardDelete = await jsonRequest(`${nodeBase}/api/v2/sliders/admin/not-an-object-id`, { method: 'DELETE', headers: managerAuth.headers, body: '{}' });
    assert.equal(hardDelete.status, 405);
    assert.equal(codeOf(hardDelete.body), 'SLIDER_HARD_DELETE_DISABLED');
    const legacyReorder = await jsonRequest(`${nodeBase}/api/v2/sliders/admin/sort-order`, { method: 'PUT', headers: managerAuth.headers, body: '{}' });
    assert.equal(legacyReorder.status, 405);
    assert.equal(codeOf(legacyReorder.body), 'SLIDER_LEGACY_REORDER_DISABLED');
    const invalidRust = await jsonRequest(`${nodeBase}/api/v2/sliders/admin/create`, {
      method: 'POST', headers: { ...managerAuth.headers, 'Idempotency-Key': syntheticKey('task16_invalid') },
      body: JSON.stringify({ expectedRevision: 0, slider: { name: '', image, link: '/task16', status: false } }),
    });
    assert.equal(invalidRust.status, 400);
    assert.equal(codeOf(invalidRust.body), 'SLIDER_NAME_INVALID');
    assert.equal((await jsonRequest(`${nodeBase}/api/v2/sliders/admin/all`, { headers: managerAuth.headers })).status, 200);

    // Trusted Rust sees the same identity decisions and sanitized messages, independently of the gateway.
    const directAnonymous = await jsonRequest(`${rustBase}/v2/sliders/admin/all`);
    assert.ok([401, 403].includes(directAnonymous.status));
    const directDenied = await jsonRequest(`${rustBase}/v2/sliders/admin/all`, { headers: trusted(nodeSecrets.API_V2_PROXY_SECRET, { _id: deniedDoc._id, email: String(deniedDoc.email), role: String(deniedDoc.role) }, shared.PUBLIC_ORIGIN) });
    assert.equal(directDenied.status, 403);
    assert.match(String(directDenied.body?.message ?? directDenied.body?.error?.message ?? ''), /Permission denied|Forbidden/u);
    assert.equal((await jsonRequest(`${nodeBase}/api/v2/sliders`)).status, 200, 'public GET remains anonymous');

    // 5–7. Revisioned lifecycle, replay/conflict, references, and audit evidence.
    const initial = await jsonRequest(`${nodeBase}/api/v2/sliders/admin/all`, { headers: managerAuth.headers });
    assert.equal(initial.status, 200, initial.text);
    assert.equal(typeof initial.body?.revision, 'number');
    let revision = Number(initial.body.revision);
    const createKey = syntheticKey('task16_create');
    claimKeys.push(createKey);
    const create = await jsonRequest(`${nodeBase}/api/v2/sliders/admin/create`, {
      method: 'POST', headers: { ...managerAuth.headers, 'Idempotency-Key': createKey },
      body: JSON.stringify(sliderBody(revision, image, false, `Task16 draft ${crypto.randomUUID()}`)),
    });
    assert.equal(create.status, 201, create.text);
    const sliderId = new ObjectId(String(create.body?.slider?._id));
    created.push({ collection: 'sliders', id: sliderId });
    await markSynthetic(db, 'sliders', sliderId, fixtureRunId);
    revision = Number(create.body.revision);
    const replay = await jsonRequest(`${nodeBase}/api/v2/sliders/admin/create`, {
      method: 'POST', headers: { ...managerAuth.headers, 'Idempotency-Key': createKey },
      body: JSON.stringify(sliderBody(revision - 1, image, false, 'different body')),
    });
    assert.equal(replay.status, 409);
    assert.equal(codeOf(replay.body), 'IDEMPOTENCY_CONFLICT');
    const replayExact = await jsonRequest(`${nodeBase}/api/v2/sliders/admin/create`, {
      method: 'POST', headers: { ...managerAuth.headers, 'Idempotency-Key': createKey },
      body: JSON.stringify({ ...sliderBody(revision - 1, image, false, String(create.body.slider.name)) }),
    });
    assert.equal(replayExact.status, 201);
    assert.equal(replayExact.body?.replayed, true);
    const staleKey = syntheticKey('task16_stale');
    claimKeys.push(staleKey);
    const stale = await jsonRequest(`${nodeBase}/api/v2/sliders/admin/create`, {
      method: 'POST', headers: { ...managerAuth.headers, 'Idempotency-Key': staleKey },
      body: JSON.stringify(sliderBody(0, image, false, 'Task16 stale')),
    });
    assert.equal(stale.status, 409);
    assert.equal(codeOf(stale.body), 'SLIDER_VERSION_CONFLICT');
    const row = await db.collection('sliders').findOne({ _id: sliderId });
    assert.ok(row);
    const revisionRow = await db.collection('slidermetadata').findOne({ _id: 'global' });
    assert.equal(Number(revisionRow?.revision), revision);
    const reference = await db.collection('managedassetreferences').findOne({ resourceType: 'slider', resourceId: sliderId, field: 'image' });
    assert.ok(reference);
    assert.equal((await db.collection('managedassetreferences').countDocuments({ resourceType: 'slider', resourceId: sliderId, field: 'image' })), 1);
    const audit = await db.collection('slideraudits').findOne({ claimId: { $exists: true }, targetId: sliderId });
    assert.ok(audit);
    assert.equal(audit?.revisionBefore, revision - 1);
    assert.equal(audit?.revisionAfter, revision);
    if (audit?._id instanceof ObjectId) auditIds.push(audit._id);

    const updateKey = syntheticKey('task16_update');
    claimKeys.push(updateKey);
    const updated = await putJson(nodeBase, `/api/v2/sliders/admin/${sliderId.toHexString()}`, {
      ...managerAuth.headers, 'Idempotency-Key': updateKey,
    }, { expectedRevision: revision, changes: { name: `Task16 updated ${crypto.randomUUID()}` } });
    assert.equal(updated.status, 200, updated.text);
    assert.match(String(updated.body?.slider?.name), /^Task16 updated /u);
    revision = Number(updated.body.revision);

    const claimEvidence = await db.collection('slideridempotencyclaims').find({
      key: { $in: claimKeys },
    }, { projection: { _id: 0, key: 1, action: 1, targetId: 1, expectedRevision: 1, payloadDigest: 1, contractVersion: 1, operatorId: 1 } }).toArray();
    assert.ok(claimEvidence.length >= 3, 'claim evidence rows');
    assert.ok(new Set(claimEvidence.map((claim) => String(claim.payloadDigest))).size >= 2, 'digest changes for action/revision/payload');
    assert.ok(claimEvidence.every((claim) => claim.contractVersion === 'slider-revision-v1'), 'claim contract binding');

    // 6. Exercise every revisioned lifecycle branch against the real API. The active transition
    // carries a real step-up grant; archive releases the managed reference and restore reacquires it.
    const managerFixtureForStepUp = managerFixture;
    assert.ok(managerFixtureForStepUp);
    const activateKey = syntheticKey('task16_activate');
    claimKeys.push(activateKey);
    const grant = await stepUp(nodeBase, shared.PUBLIC_ORIGIN, managerAuth, managerFixtureForStepUp.password, 'slider-manager');
    const activated = await putJson(nodeBase, `/api/v2/sliders/admin/${sliderId.toHexString()}`, {
      ...managerAuth.headers, 'Idempotency-Key': activateKey, 'X-Step-Up-Token': grant,
    }, { expectedRevision: revision, changes: { status: true } });
    assert.equal(activated.status, 200, activated.text);
    assert.equal(activated.body?.slider?.status, true);
    revision = Number(activated.body.revision);
    const deactivateKey = syntheticKey('task16_deactivate');
    claimKeys.push(deactivateKey);
    const deactivated = await putJson(nodeBase, `/api/v2/sliders/admin/${sliderId.toHexString()}`, {
      ...managerAuth.headers, 'Idempotency-Key': deactivateKey,
    }, { expectedRevision: revision, changes: { status: false } });
    assert.equal(deactivated.status, 200, deactivated.text);
    assert.equal(deactivated.body?.slider?.status, false);
    revision = Number(deactivated.body.revision);
    const archiveKey = syntheticKey('task16_archive');
    claimKeys.push(archiveKey);
    const archived = await postJson(nodeBase, `/api/v2/sliders/admin/${sliderId.toHexString()}/archive`, {
      ...managerAuth.headers, 'Idempotency-Key': archiveKey,
    }, { expectedRevision: revision });
    assert.equal(archived.status, 200, archived.text);
    revision = Number(archived.body.revision);
    assert.equal((await db.collection('sliders').findOne({ _id: sliderId }))?.lifecycle, 'archived');
    assert.equal(await db.collection('managedassetreferences').countDocuments({ resourceType: 'slider', resourceId: sliderId, field: 'image' }), 0);
    const restoreKey = syntheticKey('task16_restore');
    claimKeys.push(restoreKey);
    const restored = await postJson(nodeBase, `/api/v2/sliders/admin/${sliderId.toHexString()}/restore`, {
      ...managerAuth.headers, 'Idempotency-Key': restoreKey,
    }, { expectedRevision: revision });
    assert.equal(restored.status, 200, restored.text);
    revision = Number(restored.body.revision);
    assert.equal((await db.collection('sliders').findOne({ _id: sliderId }))?.lifecycle, 'active');
    assert.equal(await db.collection('managedassetreferences').countDocuments({ resourceType: 'slider', resourceId: sliderId, field: 'image' }), 1);
    const reorderKey = syntheticKey('task16_reorder');
    claimKeys.push(reorderKey);
    const currentSlidersForReorder = await db.collection('sliders')
      .find({ lifecycle: { $ne: 'archived' } }, { projection: { _id: 1 } })
      .sort({ sortOrder: 1, createdAt: 1, _id: 1 })
      .toArray();
    assert.ok(currentSlidersForReorder.some((slider) => slider._id.equals(sliderId)));
    const reordered = await putJson(nodeBase, '/api/v2/sliders/admin/reorder', {
      ...managerAuth.headers, 'Idempotency-Key': reorderKey,
    }, {
      expectedRevision: revision,
      orders: currentSlidersForReorder.map((slider, index) => ({ id: slider._id.toHexString(), sortOrder: index })),
    });
    assert.equal(reordered.status, 200, reordered.text);
    revision = Number(reordered.body.revision);
    assert.equal(revision, Number(archived.body.revision) + 2, 'lifecycle revision increments');

    // Real same-revision contention: exactly one request may publish a domain row and the global
    // revision may advance once. The loser must be a typed conflict/unknown, never a second write.
    const contentionRevision = revision;
    const contentionKeys = [syntheticKey('task16_concurrent_a'), syntheticKey('task16_concurrent_b')];
    claimKeys.push(...contentionKeys);
    const contentionResults = await Promise.all(contentionKeys.map((key, index) => jsonRequest(`${nodeBase}/api/v2/sliders/admin/create`, {
      method: 'POST',
      headers: { ...managerAuth.headers, 'Idempotency-Key': key },
      body: JSON.stringify(sliderBody(contentionRevision, image, false, `Task16 concurrent ${index} ${crypto.randomUUID()}`)),
    })));
    const contentionSuccesses = contentionResults.filter((result) => result.status === 201);
    assert.equal(contentionSuccesses.length, 1, 'create contention has one winner');
    assert.ok(contentionResults.some((result) => result.status === 409 || result.status === 503), 'create contention loser is conflict/unknown');
    for (const result of contentionSuccesses) {
      const id = new ObjectId(String(result.body?.slider?._id));
      await markSynthetic(db, 'sliders', id, fixtureRunId);
      created.push({ collection: 'sliders', id });
    }
    const afterContentionRevision = Number((await db.collection('slidermetadata').findOne({ _id: 'global' }))?.revision);
    assert.equal(afterContentionRevision, contentionRevision + 1, 'create contention increments revision once');
    revision = afterContentionRevision;

    // 7. Runtime Rust fault boundaries. Each case uses a real request and inspects the durable
    // claim/domain state; lease activation alone is never treated as runtime proof.
    let faultRevision = revision;
    const claimForKey = async (key: string) => db.collection('slideridempotencyclaims').findOne({ key });
    const beforeProbeClaims = await db.collection('slideridempotencyclaims').countDocuments({});
    const probeFault = await runRustFault('slider_transaction_probe_unavailable', () => jsonRequest(`${nodeBase}/api/v2/sliders/admin/create`, {
      method: 'POST', headers: { ...managerAuth.headers, 'Idempotency-Key': syntheticKey('task16_probe') },
      body: JSON.stringify(sliderBody(faultRevision, image, false, `Task16 probe ${crypto.randomUUID()}`)),
    }));
    assert.equal(probeFault.status, 503, 'transaction-probe-fault');
    assert.equal(codeOf(probeFault.body), 'SLIDER_TRANSACTIONS_UNAVAILABLE');
    assert.equal(await db.collection('slideridempotencyclaims').countDocuments({}), beforeProbeClaims, 'transaction probe creates no claim');

    const beforeStartKey = syntheticKey('task16_before_start');
    claimKeys.push(beforeStartKey);
    const beforeStartFault = await runRustFault('slider_before_transaction_start', () => jsonRequest(`${nodeBase}/api/v2/sliders/admin/create`, {
      method: 'POST', headers: { ...managerAuth.headers, 'Idempotency-Key': beforeStartKey },
      body: JSON.stringify(sliderBody(faultRevision, image, false, `Task16 before start ${crypto.randomUUID()}`)),
    }));
    assert.equal(beforeStartFault.status, 503);
    assert.equal(codeOf(beforeStartFault.body), 'SLIDER_TRANSACTIONS_UNAVAILABLE');
    const beforeStartClaim = await claimForKey(beforeStartKey);
    assert.equal(beforeStartClaim?.state, 'retryable', 'before-start claim remains retryable');
    assert.equal(beforeStartClaim?.transactionStartedAt, undefined);
    assert.equal(beforeStartClaim?.responseBodyJson, undefined);

    const assertUnknownFault = async (
      scenario: (typeof SLIDER_RUST_FAULT_SCENARIOS)[number],
      prefix: string,
      invoke?: (key: string) => Promise<JsonResult>,
      proofName?: string,
    ) => {
      const key = syntheticKey(prefix);
      const proof = proofName ?? scenario;
      claimKeys.push(key);
      const result = await runRustFault(scenario, invoke ? () => invoke(key) : () => jsonRequest(`${nodeBase}/api/v2/sliders/admin/create`, {
        method: 'POST', headers: { ...managerAuth.headers, 'Idempotency-Key': key },
        body: JSON.stringify(sliderBody(faultRevision, image, false, `Task16 ${prefix} ${crypto.randomUUID()}`)),
      }));

      assert.equal(result.status, 503, `${proof} response`);
      assert.equal(codeOf(result.body), 'SLIDER_COMMIT_UNKNOWN', `${proof} code`);
      const claim = await claimForKey(key);
      if (!claim) {
        const recentClaims = await db.collection('slideridempotencyclaims').find({}, { projection: { _id: 0, key: 1, action: 1, state: 1, commitUnknown: 1, targetId: 1, updatedAt: 1 } }).sort({ updatedAt: -1 }).limit(5).toArray();
        assert.fail(`${proof} claim missing; key=${key}; response=${result.text}; recent=${JSON.stringify(recentClaims)}`);
      }
      assert.equal(claim?.commitUnknown, true, `${proof} seals claim`);
      assert.equal(claim?.state, 'in_progress', `${proof} does not reclaim claim`);
      assert.equal(claim?.transactionStartedAt instanceof Date || Boolean(claim?.transactionStartedAt), true, `${proof} has start fence`);
      return key;
    };
    await assertUnknownFault('slider_after_claim_fence_before_write', 'task16_after_claim', undefined, 'post-fence-nonreclaimable');
    const revisionConflictKey = syntheticKey('task16_revision_conflict');
    claimKeys.push(revisionConflictKey);
    const revisionConflict = await runRustFault('slider_revision_conflict', () => jsonRequest(`${nodeBase}/api/v2/sliders/admin/create`, {
      method: 'POST', headers: { ...managerAuth.headers, 'Idempotency-Key': revisionConflictKey },
      body: JSON.stringify(sliderBody(faultRevision, image, false, `Task16 revision conflict ${crypto.randomUUID()}`)),
    }));
    assert.equal(revisionConflict.status, 409, 'slider revision fault response');
    assert.equal(codeOf(revisionConflict.body), 'SLIDER_VERSION_CONFLICT');
    assert.equal((await claimForKey(revisionConflictKey))?.state, 'completed', 'revision conflict is frozen');
    await assertUnknownFault('slider_after_registry_write', 'task16_after_registry');
    await assertUnknownFault('slider_after_domain_write', 'task16_after_domain');
    await assertUnknownFault('slider_audit_failure', 'task16_audit');
    await assertUnknownFault('slider_commit_unknown_unresolved', 'task16_unknown');
    await assertUnknownFault('slider_frozen_response_oversize', 'task16_oversize');
    await assertUnknownFault('slider_reference_count_mismatch', 'task16_reference_mismatch');
    const unlinkRevision = Number((await db.collection('slidermetadata').findOne({ _id: 'global' }))?.revision);
    const unlinkCreateKey = syntheticKey('task16_unlink_target');
    claimKeys.push(unlinkCreateKey);
    const unlinkCreate = await jsonRequest(`${nodeBase}/api/v2/sliders/admin/create`, {
      method: 'POST',
      headers: { ...managerAuth.headers, 'Idempotency-Key': unlinkCreateKey },
      body: JSON.stringify(sliderBody(unlinkRevision, image, false, `Task16 unlink target ${crypto.randomUUID()}`)),
    });
    assert.equal(unlinkCreate.status, 201, unlinkCreate.text);
    const unlinkTargetId = new ObjectId(String(unlinkCreate.body?.slider?._id));
    await markSynthetic(db, 'sliders', unlinkTargetId, fixtureRunId);
    created.push({ collection: 'sliders', id: unlinkTargetId });
    revision = Number(unlinkCreate.body.revision);
    faultRevision = revision;
    assert.equal(await db.collection('managedassetreferences').countDocuments({ resourceType: 'slider', resourceId: unlinkTargetId, field: 'image' }), 1, 'unlink fault target has managed reference');
    await assertUnknownFault('slider_unlink_failure', 'task16_unlink_failure', (key) => postJson(nodeBase, `/api/v2/sliders/admin/${unlinkTargetId.toHexString()}/archive`, {
      ...managerAuth.headers, 'Idempotency-Key': key,
    }, { expectedRevision: revision }));
    const orderContentionItems = await db.collection('sliders')
      .find({ lifecycle: { $ne: 'archived' } }, { projection: { _id: 1 } })
      .sort({ sortOrder: 1, _id: 1 })
      .toArray();
    await assertUnknownFault('slider_order_contention', 'task16_order_contention_fault', (key) => putJson(nodeBase, '/api/v2/sliders/admin/reorder', {
      ...managerAuth.headers, 'Idempotency-Key': key,
    }, { expectedRevision: revision, orders: orderContentionItems.map((item, index) => ({ id: item._id.toHexString(), sortOrder: index })) }));
    await assertUnknownFault('slider_create_contention', 'task16_create_contention_fault');
    await assertUnknownFault('slider_limit_contention', 'task16_limit_contention_fault');

    const completeDuringKey = syntheticKey('task16_complete_wins');
    claimKeys.push(completeDuringKey);
    const completeDuring = await runRustFault('slider_complete_during_commit_unknown_mark', () => jsonRequest(`${nodeBase}/api/v2/sliders/admin/create`, {
      method: 'POST', headers: { ...managerAuth.headers, 'Idempotency-Key': completeDuringKey },
      body: JSON.stringify(sliderBody(faultRevision, image, false, `Task16 complete wins ${crypto.randomUUID()}`)),
    }));
    assert.equal(completeDuring.status, 201, 'complete-wins-unknown-mark');
    const completeId = new ObjectId(String(completeDuring.body?.slider?._id));
    await markSynthetic(db, 'sliders', completeId, fixtureRunId);
    created.push({ collection: 'sliders', id: completeId });
    revision = Number(completeDuring.body.revision);
    const completeClaim = await claimForKey(completeDuringKey);
    assert.equal(completeClaim?.state, 'completed', 'complete wins over unknown mark');
    assert.notEqual(completeClaim?.commitUnknown, true, 'completed frozen claim is not overwritten');

    const activeLimitBase = await db.collection('sliders').countDocuments({ lifecycle: { $ne: 'archived' } });
    for (let index = 0; index < 8; index += 1) {
      const id = new ObjectId();
      await db.collection('sliders').insertOne({
        _id: id,
        name: `Task16 active limit ${index} ${crypto.randomUUID()}`,
        image,
        link: '/task16-limit',
        sortOrder: activeLimitBase + index,
        status: true,
        lifecycle: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
        task16Fixture: true,
        fixtureRunId,
      });
      created.push({ collection: 'sliders', id });
    }
    const activeLimitKey = syntheticKey('task16_active_limit');
    claimKeys.push(activeLimitKey);
    const activeGrant = await stepUp(nodeBase, shared.PUBLIC_ORIGIN, managerAuth, managerFixtureForStepUp.password, 'slider-manager');
    const activeLimit = await putJson(nodeBase, `/api/v2/sliders/admin/${sliderId.toHexString()}`, {
      ...managerAuth.headers, 'Idempotency-Key': activeLimitKey, 'X-Step-Up-Token': activeGrant,
    }, { expectedRevision: revision, changes: { status: true } });
    assert.equal(activeLimit.status, 409, 'active limit');
    assert.equal(codeOf(activeLimit.body), 'SLIDER_ACTIVE_LIMIT_REACHED');
    assert.equal((await claimForKey(activeLimitKey))?.state, 'completed');

    const totalLimitCurrent = await db.collection('sliders').countDocuments({ lifecycle: { $ne: 'archived' } });
    for (let index = totalLimitCurrent; index < 20; index += 1) {
      const id = new ObjectId();
      await db.collection('sliders').insertOne({
        _id: id,
        name: `Task16 total limit ${index} ${crypto.randomUUID()}`,
        image,
        link: '/task16-total-limit',
        sortOrder: index,
        status: false,
        lifecycle: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
        task16Fixture: true,
        fixtureRunId,
      });
      created.push({ collection: 'sliders', id });
    }
    const totalLimitKey = syntheticKey('task16_total_limit');
    claimKeys.push(totalLimitKey);
    const totalLimit = await jsonRequest(`${nodeBase}/api/v2/sliders/admin/create`, {
      method: 'POST', headers: { ...managerAuth.headers, 'Idempotency-Key': totalLimitKey },
      body: JSON.stringify(sliderBody(revision, image, false, `Task16 total limit ${crypto.randomUUID()}`)),
    });
    assert.equal(totalLimit.status, 409, 'total limit');
    assert.equal(codeOf(totalLimit.body), 'SLIDER_TOTAL_LIMIT_REACHED');
    assert.equal((await claimForKey(totalLimitKey))?.state, 'completed');

    // 8. Synchronized writer-versus-delete race: the first transaction scans zero, the guarded
    // pause lets a real legacy writer commit the same asset, then deletion retries its scan and
    // returns ASSET_IN_USE without moving the asset out of available.
    const raceUpload = await multipartUpload(`${nodeBase}/api/v2/upload?type=covers`, managerAuth.headers, `task16-race-${crypto.randomUUID()}.png`, 'image/png', PNG_1X1);
    assert.equal(raceUpload.status, 200, raceUpload.text);
    const raceImage = String(raceUpload.body.url);
    const raceAsset = await db.collection('managedassets').findOne({ canonicalPath: raceImage });
    assert.ok(raceAsset);
    await db.collection('managedassets').updateOne({ _id: raceAsset._id }, { $set: { task16Fixture: true, fixtureRunId } });
    created.push({ collection: 'managedassets', id: raceAsset._id });
    uploadedPaths.push(raceImage);
    const raceActivation = await activateFault({ stateDir, capability, scenario: 'managed_asset_delete_after_first_scan', ttlMs: 5_000 });
    const deletionPromise = jsonRequest(`${nodeBase}/api/v2/upload?type=covers&filename=${encodeURIComponent(path.basename(raceImage))}`, { method: 'DELETE', headers: catalogAuth.headers });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const raceWriter = await postJson(nodeBase, '/api/v2/articles', managerAuth.headers, {
      title: `Task16 race article ${crypto.randomUUID()}`, excerpt: 'Task16 race', content: '<p>race</p>', image: raceImage, category: 'Task16', status: 'draft',
    });
    assert.equal(raceWriter.status, 201, raceWriter.text);
    const deletion = await deletionPromise;
    assert.equal(deletion.status, 409, deletion.text);
    assert.equal(codeOf(deletion.body), 'ASSET_IN_USE');
    assert.equal((await db.collection('managedassets').findOne({ _id: raceAsset._id }))?.state, 'available');
    assert.equal((await readFaultEvidence(stateDir))?.scenario, 'managed_asset_delete_after_first_scan', 'covers-delete-race-rescan');
    if (raceWriter.body?._id) {
      const raceArticleId = new ObjectId(String(raceWriter.body._id));
      await markSynthetic(db, 'articles', raceArticleId, fixtureRunId);
      created.push({ collection: 'articles', id: raceArticleId });
    }

    // 9–11. The registry inventory and readiness gates are checked both from source and from the
    // real disposable rows. Effective writer names are explicit so future inventory drift fails.
    const readinessBefore = await db.collection('managedassets').findOne({ _id: asset._id }, { projection: { acquisitionFenceVersion: 1 } });
    await db.collection('managedassets').updateOne({ _id: asset._id }, { $set: { task16NotReadyWriter: true } });
    const notReadyCoverDelete = await jsonRequest(`${nodeBase}/api/v2/upload?type=covers&filename=${encodeURIComponent(path.basename(image))}`, { method: 'DELETE', headers: catalogAuth.headers });
    assert.equal(notReadyCoverDelete.status, 503, 'folder-readiness-fail-closed');
    assert.equal(codeOf(notReadyCoverDelete.body), 'MANAGED_ASSET_REGISTRY_UNAVAILABLE');
    await db.collection('managedassets').updateOne({ _id: asset._id }, { $unset: { task16NotReadyWriter: '' } });
    assert.equal(Number((await db.collection('managedassets').findOne({ _id: asset._id }, { projection: { acquisitionFenceVersion: 1 } }))?.acquisitionFenceVersion), Number(readinessBefore?.acquisitionFenceVersion));
    const managedWriters = await fs.readFile(path.join(root, 'rust-api', 'src', 'services', 'managed_assets.rs'), 'utf8');
    for (const writer of ['producttypes', 'flashsales', 'articles', 'rewards']) assert.match(managedWriters, new RegExp(writer));
    assert.match(managedWriters, /acquisitionFenceVersion/);
    const registrySource = await fs.readFile(path.join(root, 'rust-api', 'src', 'services', 'managed_asset_registry.rs'), 'utf8');
    assert.match(registrySource, /first scan|retry|acquisitionFenceVersion/u);
    for (const folder of ['icons', 'popups', 'instructions']) {
      const result = await jsonRequest(`${nodeBase}/api/v2/upload?type=${folder}&filename=task16-missing.png`, { method: 'DELETE', headers: catalogAuth.headers });
      assert.equal(result.status, 503, `${folder} readiness`);
      assert.equal(codeOf(result.body), 'MANAGED_ASSET_REGISTRY_UNAVAILABLE');
    }
    const uploadHandler = await fs.readFile(path.join(root, 'rust-api', 'src', 'routes', 'uploads', 'handlers.rs'), 'utf8');
    assert.match(uploadHandler, /managed_asset_deletion_ready/);
    assert.match(uploadHandler, /count_slider_references_for_deletion/);
    assert.match(uploadHandler, /transition_asset_to_deleting/);
    assert.match(uploadHandler, /retry/);

    // 12. Every closed fault can be activated only with the disposable capability; one-shot
    // consume plus bounded evidence proves no hidden production/provider fault channel exists.
    assert.equal(FAULT_SCENARIOS.filter((scenario) => scenario.startsWith('slider_')).length, 16);
    assert.deepEqual(SLIDER_RUST_FAULT_SCENARIOS.length, 15);
    assert.equal(typeof capability, 'string');
    for (const scenario of SLIDER_RUST_FAULT_SCENARIOS) {
      const activationId = await activateFault({ stateDir, capability: capability as string, scenario, ttlMs: 5_000 });
      assert.equal(await consumeFault(stateDir, scenario, activationId), activationId, scenario);
      assert.equal(await consumeFault(stateDir, scenario, activationId), null, `${scenario} one-shot`);
    }
    const faultEvidenceSource = await fs.readFile(path.join(root, 'rust-api', 'src', 'services', 'local_fault.rs'), 'utf8');
    assert.match(faultEvidenceSource, /transactionStartedAt|commitUnknown|SLIDER_COMMIT_UNKNOWN_SCENARIO/);
    assert.match(faultEvidenceSource, /gateway-owned/);
    // Remove only the marked capacity fixtures before the gateway-owned response-loss proof so
    // that the request reaches the committed 2xx boundary rather than a total-limit rejection.
    await db.collection('sliders').deleteMany({
      task16Fixture: true,
      fixtureRunId,
      name: { $regex: '^Task16 (active|total) limit' },
    });
    const responseLossKey = syntheticKey('task16_response_loss');
    const responseLossName = `Task16 response loss ${crypto.randomUUID()}`;
    claimKeys.push(responseLossKey);
    const postCommit = await withFault({ stateDir, capability: capability as string, scenario: 'slider_response_loss_after_commit', ttlMs: 5_000 }, async () => {
      const response = await jsonRequest(`${nodeBase}/api/v2/sliders/admin/create`, {
        method: 'POST', headers: { ...managerAuth.headers, 'Idempotency-Key': responseLossKey },
        body: JSON.stringify(sliderBody(revision, image, false, responseLossName)),
      });
      return response;
    });
    assert.ok([502, 503].includes(postCommit.status), `response-loss status=${postCommit.status} body=${postCommit.text}`);
    const evidence = await readFaultEvidence(stateDir);
    assert.equal(evidence?.scenario, 'slider_response_loss_after_commit', 'gateway response-loss evidence');
    const responseLossClaim = await db.collection('slideridempotencyclaims').findOne({ key: responseLossKey });
    assert.ok(responseLossClaim, 'response-loss claim remains durable');
    const responseLossSliderId = responseLossClaim?.candidateSliderId;
    if (responseLossSliderId instanceof ObjectId) {
      await markSynthetic(db, 'sliders', responseLossSliderId, fixtureRunId);
      created.push({ collection: 'sliders', id: responseLossSliderId });
    } else {
      const responseLossRow = await db.collection('sliders').findOne({ name: responseLossName }, { projection: { _id: 1 } });
      assert.ok(responseLossRow, 'response-loss domain row is discoverable for cleanup');
      await markSynthetic(db, 'sliders', responseLossRow._id, fixtureRunId);
      created.push({ collection: 'sliders', id: responseLossRow._id });
    }

    // 13. Public ETag/list/304 and legacy link sanitization remain anonymous and operationally clean.
    const legacyPublicId = new ObjectId();
    const currentForLegacy = await db.collection('sliders').countDocuments({ lifecycle: { $ne: 'archived' } });
    await db.collection('sliders').insertOne({
      _id: legacyPublicId,
      name: `Task16 legacy public ${crypto.randomUUID()}`,
      image,
      link: 'http://legacy.example.invalid/promo',
      sortOrder: -1,
      status: true,
      lifecycle: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
      task16Fixture: true,
      fixtureRunId,
    });
    created.push({ collection: 'sliders', id: legacyPublicId });
    const legacyPublic = await jsonRequest(`${nodeBase}/api/v2/sliders`);
    assert.equal(legacyPublic.status, 200);
    const legacyItem = legacyPublic.body?.find((item: any) => item?._id === legacyPublicId.toHexString());
    assert.ok(legacyItem);
    assert.equal(legacyItem.link, '', 'legacy HTTP link sanitized');

    const publicFirst = await jsonRequest(`${nodeBase}/api/v2/sliders`);
    assert.equal(publicFirst.status, 200);
    const etag = publicFirst.headers.get('etag');
    assert.ok(etag);
    assert.match(publicFirst.headers.get('cache-control') ?? '', /no-cache/u);
    const public304 = await jsonRequest(`${nodeBase}/api/v2/sliders`, { headers: { 'If-None-Match': etag as string } });
    assert.equal(public304.status, 304);
    assert.equal(public304.text, '');
    assert.doesNotMatch(JSON.stringify(publicFirst.body), /lifecycle|sortOrder|actorId|claimId|revision/u);
    assert.deepEqual((await jsonRequest(`${nodeBase}/api/v2/sliders`, { headers: { 'If-None-Match': 'W/"sliders-0", *' } })).status, 200);

    // 13. Cleanup is constrained to marked Task16 IDs and never uses a broad collection delete.
    assert.match((await fs.readFile(import.meta.filename, 'utf8')), /task16Fixture/);
  } catch (error) {
    primary = error;
  } finally {
    try {
      const db = mongo.db(shared.MONGO_DB);
      if (created.length) {
        for (const { collection, id } of created) {
          if (collection === 'sliders') {
            await db.collection('managedassetreferences').deleteMany({ resourceType: 'slider', resourceId: id });
          }
          await db.collection(collection).deleteMany({ _id: id, task16Fixture: true, fixtureRunId });
        }
      }
      if (claimKeys.length) await db.collection('slideridempotencyclaims').deleteMany({ key: { $in: claimKeys }, task16Fixture: { $ne: false } });
      if (auditIds.length) await db.collection('slideraudits').deleteMany({ _id: { $in: auditIds }, task16Fixture: { $ne: false } });
      if (uploadedPaths.length) {
        for (const filename of uploadedPaths.map((value) => path.basename(value))) {
          await fs.rm(path.join(root, 'uploads', 'covers', filename), { force: true });
        }
      }
      if (managerRow) await db.collection('authsessions').deleteMany({ userId: managerRow._id });
    } catch (cleanupError) {
      primary = primary ? new AggregateError([primary, cleanupError], 'Task16 cleanup failed') : cleanupError;
    }
    await mongo.close().catch(() => undefined);
  }
  if (primary) throw primary;
});
