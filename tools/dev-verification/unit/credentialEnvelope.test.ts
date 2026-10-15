import assert from 'node:assert/strict';
import test from 'node:test';
import { credentialResponseRequiresCookies } from '../../../server/src/routes/apiV2ProxyRoutes.ts';

const user = { id: 'synthetic', role: 'member' };

test('the retired access-token-only envelope shape now requires cookie validation', () => {
  const envelope = { accessToken: 'opaque', user };
  assert.equal(credentialResponseRequiresCookies(envelope), true);
});

test('refresh issuance and malformed successful envelopes require cookie validation', () => {
  assert.equal(credentialResponseRequiresCookies({ accessToken: 'opaque', refreshToken: 'opaque', recoveryToken: 'opaque', user }), true);
  assert.equal(credentialResponseRequiresCookies({ accessToken: 'opaque', user, unexpected: true }), true);
  for (const accessToken of ['', '   ', 'x'.repeat(8193)]) assert.equal(credentialResponseRequiresCookies({ accessToken, user }), true);
  for (const malformedUser of [null, [], 'member']) assert.equal(credentialResponseRequiresCookies({ accessToken: 'opaque', user: malformedUser }), true);
});
