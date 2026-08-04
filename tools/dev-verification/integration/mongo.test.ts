import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { MongoClient, type Db } from 'mongodb';
import { capabilityDigest } from '../database.ts';

const root = path.resolve(__dirname, '..', '..', '..');
const readEnv = async (file: string): Promise<Record<string, string>> => Object.fromEntries((await fs.readFile(file, 'utf8')).split(/\r?\n/u).filter(Boolean).map((line) => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));

async function localMongo() {
  const [env, node] = await Promise.all([readEnv(path.join(root, '.dev-verification/env/shared.env')), readEnv(path.join(root, '.dev-verification/env/node.env'))]);
  assert.equal(env.LOCAL_DEV_VERIFICATION, 'true');
  assert.equal(env.MONGO_DB, 'webtopup_task14_dev');
  const uri = new URL(env.MONGO_URI); assert.equal(uri.host, '127.0.0.1:27018'); assert.equal(uri.pathname, '/webtopup_task14_dev'); assert.deepEqual([...uri.searchParams.keys()].sort(), ['directConnection', 'replicaSet']); assert.equal(uri.searchParams.get('replicaSet'), 'rs0'); assert.equal(uri.searchParams.get('directConnection'), 'true');
  assert.ok(node.LOCAL_DESTRUCTIVE_CAPABILITY?.length >= 32);
  const client = new MongoClient(env.MONGO_URI); await client.connect(); const db = client.db(env.MONGO_DB);
  const hello = await client.db('admin').command({ hello: 1 }); assert.equal(hello.setName, 'rs0'); assert.equal(hello.isWritablePrimary, true); assert.equal(hello.hosts?.length, 1);
  const marker = await db.collection('__localVerification').findOne({ kind: 'webtopup-local-dev-verification' });
  assert.deepEqual(marker && { kind: marker.kind, databaseName: marker.databaseName, volumeName: marker.volumeName, capabilityMatches: marker.capabilityDigest === capabilityDigest(node.LOCAL_DESTRUCTIVE_CAPABILITY) }, { kind: 'webtopup-local-dev-verification', databaseName: 'webtopup_task14_dev', volumeName: 'webtopup-task14-dev_mongo-data', capabilityMatches: true });
  return { client, db };
}

async function settle(primary: unknown, teardowns: Array<() => Promise<unknown>>) { const errors: unknown[] = []; for (const teardown of teardowns) try { await teardown(); } catch (error) { errors.push(error); } if (primary && errors.length) throw new AggregateError([primary, ...errors], 'Mongo verification and cleanup failed'); if (primary) throw primary; if (errors.length === 1) throw errors[0]; if (errors.length > 1) throw new AggregateError(errors, 'Mongo verification cleanup failed'); }

test('replica set supports committed and aborted transactions', async () => {
  const { client, db } = await localMongo(); const marker = crypto.randomUUID(); const collection = db.collection('__verificationTransactionProbe'); let primary: unknown = null; let committed = client.startSession(); let aborted = client.startSession();
  try { await committed.withTransaction(async () => { await collection.insertOne({ marker, outcome: 'committed' }, { session: committed }); }); await assert.rejects(aborted.withTransaction(async () => { await collection.insertOne({ marker, outcome: 'aborted' }, { session: aborted }); throw new Error('abort probe'); }), /abort probe/u); assert.equal(await collection.countDocuments({ marker, outcome: 'committed' }), 1); assert.equal(await collection.countDocuments({ marker, outcome: 'aborted' }), 0); } catch (error) { primary = error; }
  await settle(primary, [() => committed.endSession(), () => aborted.endSession(), () => collection.deleteMany({ marker }), () => client.close()]);
});

const exactIndex = (indexes: any[], name: string, key: Record<string, number>) => indexes.find((index) => index.name === name && JSON.stringify(index.key) === JSON.stringify(key));
test('critical production indexes have exact unique and TTL semantics', async () => {
  const { client, db } = await localMongo(); let primary: unknown = null;
  try { const idem = await db.collection('idempotencyrecords').indexes(); const unique = exactIndex(idem, 'uniq_actor_route_key', { actorId: 1, routeKey: 1, idempotencyKey: 1 }); const ttl = exactIndex(idem, 'ttl_cleanup_at_completed', { cleanupAt: 1 }); assert.equal(unique?.unique, true); assert.equal(ttl?.expireAfterSeconds, 0); assert.deepEqual(ttl?.partialFilterExpression, { status: 'completed' }); const sessions = await db.collection('authsessions').indexes(); assert.equal(exactIndex(sessions, 'uniq_auth_session_session_id', { sessionId: 1 })?.unique, true); const cleanup = exactIndex(sessions, 'cleanupAt_1', { cleanupAt: 1 }); assert.equal(cleanup?.expireAfterSeconds, 0); assert.equal(cleanup?.partialFilterExpression, undefined); const slot = exactIndex(sessions, 'uniq_auth_session_owned_slot', { userId: 1, slot: 1 }); assert.equal(slot?.unique, true); assert.deepEqual(slot?.partialFilterExpression, { ownsSlot: true }); } catch (error) { primary = error; }
  await settle(primary, [() => client.close()]);
});

test('migration residue is absent and every security audit obeys the field allowlist', async () => {
  const { client, db } = await localMongo(); const traceId = crypto.randomBytes(16).toString('hex'); let primary: unknown = null;
  try { const sessions = db.collection('authsessions'); assert.equal(await sessions.countDocuments({ $or: [{ sessionVersion: { $exists: true } }, { sessionVersionAtIssue: { $exists: false } }, { migrationOperationMarker: { $exists: true } }, { pendingIssuance: { $exists: true } }] }), 0); assert.equal(await sessions.countDocuments({ immediatePredecessor: { $ne: null }, $or: [{ 'immediatePredecessor.recoverySeedNonce': { $exists: false } }, { 'immediatePredecessor.recoverySeedCiphertext': { $exists: false } }, { 'immediatePredecessor.recoveryEncryptionKeyId': { $exists: false } }, { 'immediatePredecessor.recoveryEncryptionVersion': { $exists: false } }, { 'immediatePredecessor.recoveryExpiresAt': { $exists: false } }] }), 0); const audits = db.collection('authsecurityaudits'); await audits.insertOne({ event: 'login_success', outcome: 'verification_probe', source: 'rust_domain', correlationSource: 'absent', traceId, createdAt: new Date() }); const allowedTop = new Set(['_id', 'event', 'outcome', 'userId', 'sessionId', 'source', 'traceId', 'correlationSource', 'actionGroup', 'device', 'reason', 'createdAt']); const allowedDevice = new Set(['label', 'ipPrefix', 'userAgentFamily']); const forbidden = /token|cookie|authorization|password|otp|csrf|secret|digest/i; let seenProbe = false; for await (const audit of audits.find({})) { if (audit.traceId === traceId) seenProbe = true; for (const key of Object.keys(audit)) { assert.equal(allowedTop.has(key), true); assert.equal(forbidden.test(key), false); } if (audit.device) for (const key of Object.keys(audit.device)) assert.equal(allowedDevice.has(key), true); } assert.equal(seenProbe, true); } catch (error) { primary = error; }
  await settle(primary, [() => db.collection('authsecurityaudits').deleteOne({ traceId }), () => client.close()]);
});
