import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import test from 'node:test';
import { once } from 'node:events';
import { MongoClient, ObjectId } from 'mongodb';
import { chromium } from 'playwright';
import { fixtureOtp, loginFixture } from '../e2e/fixtures.ts';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const stateDir = path.join(root, '.dev-verification');

type Env = Record<string, string>;
type JsonResult = { status: number; body: any; headers: Headers; text: string };

test('site config foundation enforces permission, revision, step-up, idempotency, and public ETag', async () => {
  const [shared, nodeSecrets, rustSecrets] = await Promise.all([
    readEnv(path.join(stateDir, 'env', 'shared.env')),
    readEnv(path.join(stateDir, 'env', 'node.env')),
    readEnv(path.join(stateDir, 'env', 'rust.env')),
  ]);
  assert.equal(shared.LOCAL_DEV_VERIFICATION, 'true');
  assert.equal(shared.MONGO_DB, 'webtopup_task14_dev');

  const denied = await loginFixture('site-config-denied');
  const manager = await loginFixture('site-config-manager');
  const inactive = await loginFixture('site-config-inactive');
  const nodeBase = `http://127.0.0.1:${shared.NODE_PORT}`;
  const rustBase = `http://127.0.0.1:${shared.RUST_PORT}`;
  const marker = `site-cfg-${crypto.randomUUID().slice(0, 8)}`;
  const mongo = new MongoClient(shared.MONGO_URI);
  let disabledRust: ChildProcess | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let primary: unknown = null;
  const cleanup: Array<() => Promise<void>> = [];

  try {
    await mongo.connect();
    const db = mongo.db(shared.MONGO_DB);
    const markerDoc = await db.collection('__localVerification').findOne({
      kind: 'webtopup-local-dev-verification',
      databaseName: 'webtopup_task14_dev',
    });
    assert.ok(markerDoc);

    const deniedLogin = await loginAtGateway(nodeBase, denied, shared.PUBLIC_ORIGIN);
    const deniedGet = await jsonRequest(`${nodeBase}/api/v2/settings/admin/all`, {
      headers: bearerHeaders(deniedLogin.accessToken, shared.PUBLIC_ORIGIN),
    });
    assert.equal(deniedGet.status, 403);
    assert.equal(errorCode(deniedGet.body), 'PERMISSION_DENIED');

    const inactiveUser = await db.collection('users').findOne(
      { email: inactive.email, task14Fixture: true },
      { projection: { _id: 1, active: 1, role: 1, email: 1 } },
    );
    assert.ok(inactiveUser);
    assert.equal(inactiveUser.active, false);
    const inactiveTrusted = await jsonRequest(`${rustBase}/v2/settings/admin/all`, {
      headers: trustedHeaders(
        nodeSecrets.API_V2_PROXY_SECRET,
        inactiveUser._id,
        inactive.email,
        String(inactiveUser.role),
        shared.PUBLIC_ORIGIN,
      ),
    });
    assert.equal(inactiveTrusted.status, 403);

    // Manager uses browser session so step-up grant binds to SID.
    browser = await chromium.launch({
      executablePath: process.env.DEV_VERIFICATION_CHROME_EXECUTABLE || undefined,
      headless: true,
      args: [
        '--host-resolver-rules=MAP webtopup.local.test 127.0.0.1',
        '--ignore-certificate-errors',
      ],
    });
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      baseURL: shared.PUBLIC_ORIGIN,
    });
    const page = await context.newPage();
    const managerUser = await db.collection('users').findOne(
      { email: manager.email, task14Fixture: true },
      { projection: { _id: 1 } },
    );
    assert.ok(managerUser);
    await db.collection('authsessions').deleteMany({ userId: managerUser._id });

    await page.goto(`${shared.PUBLIC_ORIGIN}${manager.loginPath}`);
    await page.getByLabel('Email').fill(manager.email);
    await page.getByLabel('Password').fill(manager.password);
    await page.getByRole('button', { name: 'Masuk sekarang' }).click();
    await page.getByLabel('Kode OTP').waitFor({ timeout: 20_000 });
    const otp = await fixtureOtp('site-config-manager');
    await page.getByLabel('Kode OTP').fill(otp);
    await page.getByRole('button', { name: 'Verifikasi & masuk' }).click();
    await page.waitForURL(/\/admin\/dashboard$/, { timeout: 20_000 });

    const initial = await page.evaluate(async () => {
      const api = (await import('/src/api/index.ts')).apiV2 as any;
      const response = await api.get('/settings/admin/all', { _skipAuthRefresh: true });
      return { status: response.status, data: response.data };
    });
    assert.equal(initial.status, 200);
    assert.equal(typeof initial.data?.revision, 'number');
    const startRevision = Number(initial.data.revision);
    const originalBrand = String(initial.data.brand ?? 'Danayasa');
    const originalTitle = String(initial.data.title ?? 'Title');

    cleanup.push(async () => {
      // Best-effort restore through versioned mutation if possible.
      try {
        const current = await page.evaluate(async () => {
          const api = (await import('/src/api/index.ts')).apiV2 as any;
          return (await api.get('/settings/admin/all', { _skipAuthRefresh: true })).data;
        });
        await page.evaluate(async ({ revision, brand, title, key }) => {
          const api = (await import('/src/api/index.ts')).apiV2 as any;
          await api.put('/settings/admin/update', {
            expectedRevision: revision,
            changes: { brand, title },
          }, {
            headers: { 'Idempotency-Key': key },
            _skipAuthRefresh: true,
          });
        }, {
          revision: Number(current.revision),
          brand: originalBrand,
          title: originalTitle,
          key: `sitecfg_restore_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
        });
      } catch {
        // ignore restore failures in cleanup
      }
    });

    // Non-sensitive brand change without step-up grant.
    const brandKey = `sitecfg_brand_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const brandNext = `${originalBrand} ${marker}`.slice(0, 80);
    const brandSave = await page.evaluate(async ({ revision, brand, key }) => {
      const api = (await import('/src/api/index.ts')).apiV2 as any;
      const response = await api.put('/settings/admin/update', {
        expectedRevision: revision,
        changes: { brand },
      }, {
        headers: { 'Idempotency-Key': key },
        _skipAuthRefresh: true,
      });
      return { status: response.status, data: response.data };
    }, { revision: startRevision, brand: brandNext, key: brandKey });
    assert.equal(brandSave.status, 200);
    assert.equal(brandSave.data?.success, true);
    assert.equal(brandSave.data?.replayed, false);
    assert.equal(Number(brandSave.data?.revision), startRevision + 1);

    const brandReplay = await page.evaluate(async ({ revision, brand, key }) => {
      const api = (await import('/src/api/index.ts')).apiV2 as any;
      const response = await api.put('/settings/admin/update', {
        expectedRevision: revision,
        changes: { brand },
      }, {
        headers: { 'Idempotency-Key': key },
        _skipAuthRefresh: true,
      });
      return { status: response.status, data: response.data };
    }, { revision: startRevision, brand: brandNext, key: brandKey });
    assert.equal(brandReplay.status, 200);
    assert.equal(brandReplay.data?.replayed, true);
    assert.equal(Number(brandReplay.data?.revision), startRevision + 1);

    // Sensitive change without grant → AUTH_STEP_UP_REQUIRED and no claim.
    const claimsBefore = await db.collection('siteconfigidempotencyclaims').countDocuments({});
    const sensitiveKey = `sitecfg_sens_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const sensitiveDenied = await page.evaluate(async ({ revision, key }) => {
      const api = (await import('/src/api/index.ts')).apiV2 as any;
      try {
        await api.put('/settings/admin/update', {
          expectedRevision: revision,
          changes: { maintenanceMode: true, maintenanceMessage: 'Pemeliharaan verifikasi task14' },
        }, {
          headers: { 'Idempotency-Key': key },
          _skipAuthRefresh: true,
        });
        return { status: 200, code: null, group: null };
      } catch (error: any) {
        return {
          status: error?.response?.status ?? 0,
          code: error?.response?.data?.error?.code ?? error?.response?.data?.code ?? null,
          group: error?.response?.data?.error?.actionGroup ?? error?.response?.data?.actionGroup ?? null,
        };
      }
    }, { revision: startRevision + 1, key: sensitiveKey });
    assert.equal(sensitiveDenied.status, 403);
    assert.equal(sensitiveDenied.code, 'AUTH_STEP_UP_REQUIRED');
    assert.equal(sensitiveDenied.group, 'settings.sensitive');
    assert.equal(await db.collection('siteconfigidempotencyclaims').countDocuments({}), claimsBefore);

    // Step-up then same key succeeds.
    const stepOtp = await fixtureOtp('site-config-manager');
    const grant = await page.evaluate(async ({ password, otp }) => {
      const api = (await import('/src/api/index.ts')).apiV2 as any;
      const response = await api.post('/auth/step-up', {
        password,
        otp,
        actionGroup: 'settings.sensitive',
      }, { _skipAuthRefresh: true });
      return {
        status: response.status,
        token: response.data?.grantToken ?? null,
      };
    }, { password: manager.password, otp: stepOtp });
    assert.equal(grant.status, 200);
    assert.equal(typeof grant.token, 'string');

    const sensitiveSave = await page.evaluate(async ({ revision, key, token }) => {
      const api = (await import('/src/api/index.ts')).apiV2 as any;
      const response = await api.put('/settings/admin/update', {
        expectedRevision: revision,
        changes: { maintenanceMode: true, maintenanceMessage: 'Pemeliharaan verifikasi task14' },
      }, {
        headers: {
          'Idempotency-Key': key,
          'X-Step-Up-Token': token,
        },
        _skipAuthRefresh: true,
      });
      return { status: response.status, data: response.data };
    }, { revision: startRevision + 1, key: sensitiveKey, token: grant.token });
    assert.equal(sensitiveSave.status, 200);
    assert.equal(sensitiveSave.data?.success, true);
    assert.equal(Number(sensitiveSave.data?.revision), startRevision + 2);

    // Same key + different body => conflict.
    const conflict = await page.evaluate(async ({ revision, key }) => {
      const api = (await import('/src/api/index.ts')).apiV2 as any;
      try {
        await api.put('/settings/admin/update', {
          expectedRevision: revision,
          changes: { title: 'changed-after-bind' },
        }, {
          headers: { 'Idempotency-Key': key },
          _skipAuthRefresh: true,
        });
        return { status: 200, code: null };
      } catch (error: any) {
        return {
          status: error?.response?.status ?? 0,
          code: error?.response?.data?.error?.code ?? error?.response?.data?.code ?? null,
        };
      }
    }, { revision: startRevision + 2, key: sensitiveKey });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.code, 'IDEMPOTENCY_CONFLICT');

    // Stale revision freeze.
    const stale = await page.evaluate(async ({ key }) => {
      const api = (await import('/src/api/index.ts')).apiV2 as any;
      try {
        await api.put('/settings/admin/update', {
          expectedRevision: 0,
          changes: { title: 'stale-write' },
        }, {
          headers: { 'Idempotency-Key': key },
          _skipAuthRefresh: true,
        });
        return { status: 200, code: null, body: null };
      } catch (error: any) {
        return {
          status: error?.response?.status ?? 0,
          code: error?.response?.data?.error?.code ?? null,
          body: error?.response?.data ?? null,
        };
      }
    }, { key: `sitecfg_stale_${crypto.randomUUID().replace(/-/g, '').slice(0, 18)}` });
    assert.equal(stale.status, 409);
    assert.equal(stale.code, 'SETTINGS_VERSION_CONFLICT');
    assert.equal(typeof stale.body?.error?.currentRevision, 'number');
    assert.ok(stale.body?.error?.currentSettings);

    // Disabled-transaction subprocess.
    disabledRust = await spawnDisabledTransactionsRust(shared, rustSecrets);
    const disabledPort = 19012;
    await waitForHttp(`http://127.0.0.1:${disabledPort}/api/v2/health`);
    const disabled = await jsonRequest(`http://127.0.0.1:${disabledPort}/v2/settings/admin/update`, {
      method: 'PUT',
      headers: {
        ...trustedHeaders(
          nodeSecrets.API_V2_PROXY_SECRET,
          managerUser._id,
          manager.email,
          'cs',
          shared.PUBLIC_ORIGIN,
        ),
        'Idempotency-Key': `sitecfg_disabled_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
      },
      body: JSON.stringify({
        expectedRevision: startRevision + 2,
        changes: { brand: `${brandNext}-disabled` },
      }),
    });
    assert.equal(disabled.status, 503);
    assert.equal(errorCode(disabled.body), 'SETTINGS_TRANSACTIONS_UNAVAILABLE');

    // Public ETag / no-cache / 304.
    const publicFirst = await jsonRequest(`${nodeBase}/api/v2/settings/public`, {
      headers: { Origin: shared.PUBLIC_ORIGIN },
    });
    assert.equal(publicFirst.status, 200);
    assert.equal(typeof publicFirst.body?.revision, 'number');
    const etag = publicFirst.headers.get('etag') || publicFirst.headers.get('ETag');
    const cacheControl = publicFirst.headers.get('cache-control') || '';
    assert.ok(etag && etag.includes('site-settings-'));
    assert.match(cacheControl, /no-cache/i);
    const public304 = await jsonRequest(`${nodeBase}/api/v2/settings/public`, {
      headers: {
        Origin: shared.PUBLIC_ORIGIN,
        'If-None-Match': etag!,
      },
    });
    assert.equal(public304.status, 304);
    assert.equal(public304.text, '');

    // Restore maintenance off with fresh intent + grant.
    const restoreOtp = await fixtureOtp('site-config-manager');
    const restoreGrant = await page.evaluate(async ({ password, otp }) => {
      const api = (await import('/src/api/index.ts')).apiV2 as any;
      const response = await api.post('/auth/step-up', {
        password,
        otp,
        actionGroup: 'settings.sensitive',
      }, { _skipAuthRefresh: true });
      return response.data?.grantToken ?? null;
    }, { password: manager.password, otp: restoreOtp });
    const current = await page.evaluate(async () => {
      const api = (await import('/src/api/index.ts')).apiV2 as any;
      return (await api.get('/settings/admin/all', { _skipAuthRefresh: true })).data;
    });
    await page.evaluate(async ({ revision, token, brand, title, key }) => {
      const api = (await import('/src/api/index.ts')).apiV2 as any;
      await api.put('/settings/admin/update', {
        expectedRevision: revision,
        changes: {
          maintenanceMode: false,
          brand,
          title,
        },
      }, {
        headers: {
          'Idempotency-Key': key,
          'X-Step-Up-Token': token,
        },
        _skipAuthRefresh: true,
      });
    }, {
      revision: Number(current.revision),
      token: restoreGrant,
      brand: originalBrand,
      title: originalTitle,
      key: `sitecfg_final_${crypto.randomUUID().replace(/-/g, '').slice(0, 18)}`,
    });
  } catch (error) {
    primary = error;
  } finally {
    for (const fn of cleanup.reverse()) {
      try { await fn(); } catch { /* ignore */ }
    }
    if (disabledRust && disabledRust.pid) {
      try { process.kill(disabledRust.pid, 'SIGTERM'); } catch { /* ignore */ }
    }
    if (browser) await browser.close().catch(() => undefined);
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

async function loginAtGateway(base: string, fixture: Awaited<ReturnType<typeof loginFixture>>, origin: string) {
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
      deviceName: 'Task14 site-config foundation',
    }),
  });
  assert.equal(response.status, 200, response.text);
  const accessToken = response.body?.accessToken;
  assert.equal(typeof accessToken, 'string');
  return { accessToken: accessToken as string };
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
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body, headers: response.headers, text };
}

function errorCode(body: any): unknown {
  return body?.error?.code ?? body?.code;
}

async function waitForHttp(url: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`readiness failed for ${url}`);
}

async function spawnDisabledTransactionsRust(shared: Env, rustSecrets: Env): Promise<ChildProcess> {
  const command = path.join(root, 'rust-api', 'target', 'debug', 'webtopup-rust-api');
  const child = spawn(command, [], {
    cwd: path.join(root, 'rust-api'),
    env: {
      ...process.env,
      ...shared,
      ...rustSecrets,
      API_V2_HOST: '127.0.0.1',
      API_V2_PORT: '19012',
      MONGO_TRANSACTIONS_ENABLED: 'false',
      OTEL_ENABLED: 'false',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  await once(child, 'spawn');
  return child;
}
