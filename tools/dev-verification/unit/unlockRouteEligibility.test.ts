import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {
  cookieLockedSessionIdentity,
  credentialSid,
  staffUnlockRouteAllowed,
} from '../../../server/src/middlewares/sessionAuth.ts';

const now = new Date('2026-01-01T00:00:00.000Z');
const lockedStaff = { role: 'cs', status: 'locked', idleExpiresAt: now } as never;

test('cookie-only unlock requires matching canonical credential SIDs and a bound locked staff session', () => {
  const sid = '0123456789abcdef01234567';
  const secret = Buffer.alloc(32, 1).toString('base64url');
  const recoverySecret = Buffer.alloc(32, 2).toString('base64url');
  const user = {
    id: 'abcdefabcdefabcdefabcdef',
    email: 'staff@example.test',
    role: 'admin',
    permissions: {},
    active: true,
    sessionVersion: 4,
  } as const;
  const session = {
    ...lockedStaff,
    sessionId: sid,
    userId: user.id,
    role: 'admin',
    sessionVersionAtIssue: 4,
    absoluteExpiresAt: new Date(now.getTime() + 60 * 60 * 1000),
  };

  assert.deepEqual(
    cookieLockedSessionIdentity(`${sid}.${secret}`, `${sid}.${recoverySecret}`, session, user, now),
    {
      id: user.id,
      email: user.email,
      role: 'admin',
      permissions: {},
      sessionId: sid,
      authMode: 'refresh-session',
    }
  );
  assert.equal(
    credentialSid(`${sid}.${'B'.repeat(43)}`),
    null,
    'a noncanonical base64url spelling must not identify a session'
  );
  assert.equal(cookieLockedSessionIdentity(`${sid}.${secret}`, `fedcba987654321001234567.${secret}`, session, user, now), null);
  assert.equal(cookieLockedSessionIdentity('not-a-token', `${sid}.${secret}`, session, user, now), null);
  assert.equal(cookieLockedSessionIdentity(`${sid}.${secret}`, `${sid}.${secret}`, { ...session, status: 'active', idleExpiresAt: new Date(now.getTime() + 60_000) }, user, now), null);
  assert.equal(cookieLockedSessionIdentity(`${sid}.${secret}`, `${sid}.${secret}`, session, { ...user, active: false }, now), null);
  assert.equal(cookieLockedSessionIdentity(`${sid}.${secret}`, `${sid}.${secret}`, session, { ...user, sessionVersion: 5 }, now), null);
});

test('the unlock route uses the cookie-aware authenticator rather than bearer-only authenticate', () => {
  const source = fs.readFileSync(
    new URL('../../../server/src/routes/apiV2ProxyRoutes.ts', import.meta.url),
    'utf8'
  );
  const route = source.match(/app\.post\('\/auth\/unlock',[^\n]+/)?.[0] ?? '';
  assert.match(route, /authenticateUnlock/);
  assert.doesNotMatch(route, /(?:^|[,\s])authenticate(?:[,\]\s])/);
});

test('locked staff unlock accepts canonical and Fastify-prefixed route URLs only', () => {
  assert.equal(staffUnlockRouteAllowed('POST', '/auth/unlock', 'cs', lockedStaff, now), true);
  assert.equal(staffUnlockRouteAllowed('POST', '/api/v2/auth/unlock', 'cs', lockedStaff, now), true);
  assert.equal(staffUnlockRouteAllowed('GET', '/api/v2/auth/unlock', 'cs', lockedStaff, now), false);
  assert.equal(staffUnlockRouteAllowed('POST', '/api/v2/auth/unlock-extra', 'cs', lockedStaff, now), false);
  assert.equal(staffUnlockRouteAllowed('POST', '/api/v2/auth/unlock', 'member', lockedStaff, now), false);
});
