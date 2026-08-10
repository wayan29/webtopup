import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import test from 'node:test';
import { MongoClient, ObjectId, type Db } from 'mongodb';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const stateDir = path.join(root, '.dev-verification');

type Env = Record<string, string>;
type JsonResult = { status: number; body: any; text: string };

test('giveaway execution is atomic, permanently idempotent, and fails closed without transactions', async () => {
  const [shared, nodeSecrets, rustSecrets, manifest] = await Promise.all([
    readEnv(path.join(stateDir, 'env', 'shared.env')),
    readEnv(path.join(stateDir, 'env', 'node.env')),
    readEnv(path.join(stateDir, 'env', 'rust.env')),
    fs.readFile(path.join(stateDir, 'fixture-manifest.json'), 'utf8').then((value) => JSON.parse(value) as Array<{ alias: string; fixtureRunId: string }>),
  ]);
  assert.equal(shared.LOCAL_DEV_VERIFICATION, 'true');
  assert.equal(shared.MONGO_DB, 'webtopup_task14_dev');
  assert.match(shared.MONGO_URI, /replicaSet=rs0/u);

  const runId = `atomic-giveaway-smoke-${crypto.randomUUID()}`;
  const actorFixture = manifest.find((item) => item.alias === 'finance-actor');
  const targetFixture = manifest.find((item) => item.alias === 'finance-target');
  assert.ok(actorFixture && targetFixture, 'finance fixtures must be seeded');
  const actorEmail = `finance-actor.${actorFixture.fixtureRunId}@task14.invalid`;
  const targetEmail = `finance-target.${targetFixture.fixtureRunId}@task14.invalid`;
  const rustBase = `http://127.0.0.1:${shared.RUST_PORT}`;
  const mongo = new MongoClient(shared.MONGO_URI);
  let disabledRust: ChildProcess | undefined;
  let primary: unknown = null;
  let actorId: ObjectId | undefined;
  let targetId: ObjectId | undefined;
  let originalBalance = 0;
  let originalPermissions: Record<string, unknown> | undefined;
  const campaignNames: string[] = [];
  const idempotencyKeys: string[] = [];

  try {
    await mongo.connect();
    const db = mongo.db(shared.MONGO_DB);
    const users = db.collection('users');
    const actor = await users.findOne({ email: actorEmail, task14Fixture: true }, { projection: { _id: 1, email: 1, role: 1, permissions: 1 } });
    const target = await users.findOne({ email: targetEmail, task14Fixture: true }, { projection: { _id: 1, balance: 1, role: 1 } });
    assert.ok(actor && target, 'fixture users must exist');
    actorId = actor._id;
    targetId = target._id;
    assert.equal(actor.role, 'admin');
    assert.equal(target.role, 'member');
    originalBalance = Number(target.balance ?? 0);
    originalPermissions = { ...(actor.permissions as Record<string, unknown> ?? {}) };

    await users.updateOne({ _id: actorId }, { $set: { 'permissions.manageVouchers': true } });
    const trustedHeaders = proxyHeaders(nodeSecrets.API_V2_PROXY_SECRET!, actorId, actorEmail);
    trustedHeaders['x-webtopup-step-up-group'] = 'finance.adjust_balance';

    const giveawayIndexes = await db.collection('balancegiveaways').indexes();
    const giveawayIndex = giveawayIndexes.find((index) => index.name === 'uniq_balance_giveaway_operator_key');
    assert.equal(giveawayIndex?.unique, true);
    assert.deepEqual(giveawayIndex?.key, { idempotencyOperatorId: 1, idempotencyKey: 1 });
    assert.equal(giveawayIndex?.expireAfterSeconds, undefined);

    const list = await jsonRequest(`${rustBase}/v2/vouchers/giveaways`, { method: 'GET', headers: trustedHeaders });
    assert.equal(list.status, 200, list.text);
    assert.equal(list.body.executionAvailable, true);

    const firstKey = crypto.randomUUID();
    idempotencyKeys.push(firstKey);
    const firstName = `${runId}-first`;
    campaignNames.push(firstName);
    const previewPayload = {
      name: firstName,
      totalPool: 10_000,
      winnerCount: 1,
      minAmount: 10_000,
      maxAmount: 10_000,
      participantFilter: 'emails',
      emails: targetEmail,
      note: 'atomic first',
    };
    const preview = await jsonRequest(`${rustBase}/v2/vouchers/giveaways/preview`, {
      method: 'POST', headers: trustedHeaders, body: JSON.stringify(previewPayload),
    });
    assert.equal(preview.status, 200, preview.text);
    assert.equal(preview.body.executionAvailable, true);
    assert.equal(preview.body.winners?.[0]?.userId, targetId.toHexString());
    const firstPayload = { ...previewPayload, seed: String(preview.body.seed) };

    const first = await execute(rustBase, trustedHeaders, firstPayload, firstKey);
    assert.equal(first.status, 200, first.text);
    assert.equal(first.body.campaign.status, 'completed');
    const firstCampaignId = first.body.campaign._id;
    assert.ok(firstCampaignId);
    assert.equal(await users.findOne({ _id: targetId }).then((row) => Number(row?.balance ?? 0)), originalBalance + 10_000);
    assert.equal(await db.collection('userbalanceadjustments').countDocuments({ source: 'balance_giveaway', idempotencyKey: firstKey }), 1);
    assert.equal(await db.collection('balancegiveaways').countDocuments({ _id: new ObjectId(firstCampaignId), status: 'completed' }), 1);

    const replay = await execute(rustBase, trustedHeaders, firstPayload, firstKey);
    assert.equal(replay.status, 200, replay.text);
    assert.equal(replay.body.campaign._id, firstCampaignId);
    assert.equal(await users.findOne({ _id: targetId }).then((row) => Number(row?.balance ?? 0)), originalBalance + 10_000);
    assert.equal(await db.collection('userbalanceadjustments').countDocuments({ source: 'balance_giveaway', idempotencyKey: firstKey }), 1);

    const conflict = await execute(rustBase, trustedHeaders, { ...firstPayload, note: 'different payload' }, firstKey);
    assert.equal(conflict.status, 409, conflict.text);
    assert.equal(conflict.body.error?.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(await users.findOne({ _id: targetId }).then((row) => Number(row?.balance ?? 0)), originalBalance + 10_000);

    const concurrentKey = crypto.randomUUID();
    idempotencyKeys.push(concurrentKey);
    const concurrentName = `${runId}-concurrent`;
    campaignNames.push(concurrentName);
    const concurrentPayload = {
      name: concurrentName,
      totalPool: 7_000,
      winnerCount: 1,
      minAmount: 7_000,
      maxAmount: 7_000,
      participantFilter: 'emails',
      emails: targetEmail,
      note: 'atomic concurrent',
      seed: '884422',
    };
    const concurrent = await Promise.all(Array.from({ length: 8 }, () => execute(rustBase, trustedHeaders, concurrentPayload, concurrentKey)));
    assert.ok(concurrent.some((result) => result.status === 200), JSON.stringify(concurrent.map(({ status, body }) => ({ status, code: body?.error?.code }))));
    assert.ok(concurrent.every((result) => [200, 409].includes(result.status)), JSON.stringify(concurrent.map(({ status, body }) => ({ status, code: body?.error?.code }))));
    const concurrentCampaigns = await db.collection('balancegiveaways').find({ idempotencyOperatorId: actorId, idempotencyKey: concurrentKey }).toArray();
    assert.equal(concurrentCampaigns.length, 1);
    assert.equal(concurrentCampaigns[0]?.status, 'completed');
    assert.equal(await db.collection('userbalanceadjustments').countDocuments({ source: 'balance_giveaway', idempotencyKey: concurrentKey }), 1);
    assert.equal(await users.findOne({ _id: targetId }).then((row) => Number(row?.balance ?? 0)), originalBalance + 17_000);

    await assertAbortLeavesNoGiveawayEffect(shared.MONGO_URI, db, targetId, runId);
    const disabledPayload = {
      name: `${runId}-disabled`,
      totalPool: 1_000,
      winnerCount: 1,
      minAmount: 1_000,
      maxAmount: 1_000,
      participantFilter: 'emails',
      emails: targetEmail,
      note: 'atomic disabled',
      seed: '9911',
    };
    const disabledName = disabledPayload.name;
    await db.collection('users').updateOne({ _id: targetId }, { $set: { balance: originalBalance } });
    disabledRust = await startDisabledRust(shared, rustSecrets);
    const disabledList = await jsonRequest('http://127.0.0.1:19012/v2/vouchers/giveaways', { method: 'GET', headers: trustedHeaders });
    assert.equal(disabledList.status, 200, disabledList.text);
    assert.equal(disabledList.body.executionAvailable, false);
    const disabledPreview = await jsonRequest('http://127.0.0.1:19012/v2/vouchers/giveaways/preview', {
      method: 'POST', headers: trustedHeaders, body: JSON.stringify(disabledPayload),
    });
    assert.equal(disabledPreview.status, 200, disabledPreview.text);
    assert.equal(disabledPreview.body.executionAvailable, false);
    const beforeDisabled = await users.findOne({ _id: targetId }, { projection: { balance: 1 } });
    const disabled = await jsonRequest('http://127.0.0.1:19012/v2/vouchers/giveaways', {
      method: 'POST',
      headers: {
        ...trustedHeaders,
        'Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify(disabledPayload),
    });
    assert.equal(disabled.status, 503, disabled.text);
    assert.equal(disabled.body.error?.code, 'GIVEAWAY_TRANSACTIONS_UNAVAILABLE');
    assert.equal(await users.findOne({ _id: targetId }).then((row) => Number(row?.balance ?? 0)), Number(beforeDisabled?.balance ?? 0));
    assert.equal(await db.collection('balancegiveaways').countDocuments({ name: disabledName }), 0);
  } catch (error) {
    primary = error;
  } finally {
    if (disabledRust) await stopProcess(disabledRust);
    try {
      const db = mongo.db(shared.MONGO_DB);
      const marker = await db.collection('__localVerification').findOne({ kind: 'webtopup-local-dev-verification', databaseName: 'webtopup_task14_dev' });
      assert.ok(marker, 'cleanup requires disposable verification marker');
      if (campaignNames.length) await db.collection('balancegiveaways').deleteMany({ name: { $in: campaignNames } });
      if (idempotencyKeys.length) await db.collection('userbalanceadjustments').deleteMany({ source: 'balance_giveaway', idempotencyKey: { $in: idempotencyKeys } });
      if (actorId && originalPermissions) await db.collection('users').updateOne({ _id: actorId }, { $set: { permissions: originalPermissions } });
      if (targetId) await db.collection('users').updateOne({ _id: targetId }, { $set: { balance: originalBalance } });
      if (actorId) await db.collection('authsessions').deleteMany({ userId: actorId });
    } catch (error) {
      primary = primary ? new AggregateError([primary, error], 'giveaway verification cleanup failed') : error;
    }
    await mongo.close();
  }
  if (primary) throw primary;
});

async function readEnv(file: string): Promise<Env> {
  return Object.fromEntries((await fs.readFile(file, 'utf8')).split(/\r?\n/u).filter(Boolean).map((line) => {
    const split = line.indexOf('=');
    return [line.slice(0, split), line.slice(split + 1)];
  }));
}

function proxyHeaders(secret: string, userId: ObjectId, email: string): Record<string, string> {
  return {
    'x-api-v2-proxy-secret': secret,
    'x-webtopup-user-id': userId.toHexString(),
    'x-webtopup-user-role': 'admin',
    'x-webtopup-user-email': email,
    Origin: 'https://webtopup.local.test:9443',
    'Content-Type': 'application/json',
  };
}

async function jsonRequest(url: string, options: RequestInit = {}): Promise<JsonResult> {
  const response = await fetch(url, options);
  const text = await response.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body, text };
}

async function execute(rustBase: string, headers: Record<string, string>, payload: Record<string, unknown>, key: string): Promise<JsonResult> {
  return jsonRequest(`${rustBase}/v2/vouchers/giveaways`, {
    method: 'POST',
    headers: { ...headers, 'Idempotency-Key': key },
    body: JSON.stringify(payload),
  });
}

async function assertAbortLeavesNoGiveawayEffect(mongoUri: string, db: Db, targetId: ObjectId, runId: string): Promise<void> {
  const marker = `${runId}-abort`;
  const before = await db.collection('users').findOne({ _id: targetId }, { projection: { balance: 1 } });
  const client = new MongoClient(mongoUri);
  await client.connect();
  try {
    const probeDb = client.db(db.databaseName);
    const session = client.startSession();
    try {
      await assert.rejects(session.withTransaction(async () => {
        await probeDb.collection('users').updateOne({ _id: targetId }, { $inc: { balance: 5_000 } }, { session });
        await probeDb.collection('userbalanceadjustments').insertOne({ user: targetId, source: 'balance_giveaway', reason: marker, amount: 5_000 }, { session });
        await probeDb.collection('balancegiveaways').insertOne({ name: marker, status: 'completed', winners: [{ userId: targetId, amount: 5_000 }] }, { session });
        throw new Error('forced giveaway abort');
      }), /forced giveaway abort/u);
    } finally {
      await session.endSession();
    }
  } finally {
    await client.close();
  }
  assert.equal(await db.collection('users').findOne({ _id: targetId }).then((row) => Number(row?.balance ?? 0)), Number(before?.balance ?? 0));
  assert.equal(await db.collection('userbalanceadjustments').countDocuments({ reason: marker }), 0);
  assert.equal(await db.collection('balancegiveaways').countDocuments({ name: marker }), 0);
}

async function startDisabledRust(shared: Env, rust: Env): Promise<ChildProcess> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...shared,
    ...rust,
    API_V2_HOST: '127.0.0.1',
    API_V2_PORT: '19012',
    API_V2_ALLOWED_ORIGIN: shared.PUBLIC_ORIGIN,
    MONGO_TRANSACTIONS_ENABLED: 'false',
    SESSION_REFRESH_ENABLED: 'true',
    SESSION_REFRESH_MEMBER_COHORT_PERCENT: '0',
    SESSION_REFRESH_CS_COHORT_PERCENT: '0',
    SESSION_REFRESH_ADMIN_COHORT_PERCENT: '100',
    SESSION_REFRESH_OWNER_COHORT_PERCENT: '0',
    LEGACY_ACCESS_TOKEN_ACCEPT_UNTIL: '',
    OTEL_ENABLED: 'false',
  };
  const child = spawn(path.join(root, 'rust-api', 'target', 'debug', 'webtopup-rust-api'), [], { cwd: path.join(root, 'rust-api'), env, stdio: ['ignore', 'ignore', 'ignore'] });
  await waitForHttp('http://127.0.0.1:19012/api/v2/health', child);
  return child;
}

async function waitForHttp(url: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`disabled Rust exited before readiness: ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch { /* retry while process boots */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`disabled Rust did not become ready: ${url}`);
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    once(child, 'exit').then(() => undefined),
    new Promise((resolve) => setTimeout(() => { child.kill('SIGKILL'); resolve(undefined); }, 5_000)),
  ]);
}
