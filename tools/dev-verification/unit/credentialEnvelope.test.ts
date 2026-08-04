import assert from 'node:assert/strict';
import test from 'node:test';
import { credentialResponseRequiresCookies } from '../../../server/src/routes/apiV2ProxyRoutes.ts';

const user = { id: 'synthetic', role: 'member' };

test('exact legacy success envelope is exempt only while gateway cutoff permits it', () => {
  const envelope = { accessToken: 'opaque', user };
  assert.equal(credentialResponseRequiresCookies(envelope, true), false);
  assert.equal(credentialResponseRequiresCookies(envelope, false), true);
  assert.equal(credentialResponseRequiresCookies(envelope), true);
});

test('refresh issuance and malformed successful envelopes require cookie validation', () => {
  assert.equal(credentialResponseRequiresCookies({ accessToken: 'opaque', refreshToken: 'opaque', recoveryToken: 'opaque', user }, true), true);
  assert.equal(credentialResponseRequiresCookies({ accessToken: 'opaque', user, unexpected: true }, true), true);
  for (const accessToken of ['', '   ', 'x'.repeat(8193)]) assert.equal(credentialResponseRequiresCookies({ accessToken, user }, true), true);
  for (const malformedUser of [null, [], 'member']) assert.equal(credentialResponseRequiresCookies({ accessToken: 'opaque', user: malformedUser }, true), true);
});
