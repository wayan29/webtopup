import assert from 'node:assert/strict';
import test from 'node:test';
import { getLegacyAccessTokenAcceptUntilMs } from '../../../server/src/utils/sessionConfig.ts';

test('production cutoff distinguishes explicit disabled empty value from missing configuration', () => {
  const previous = { node: process.env.NODE_ENV, cutoff: process.env.LEGACY_ACCESS_TOKEN_ACCEPT_UNTIL };
  try {
    process.env.NODE_ENV = 'production';
    process.env.LEGACY_ACCESS_TOKEN_ACCEPT_UNTIL = '';
    assert.equal(getLegacyAccessTokenAcceptUntilMs(), null);
    delete process.env.LEGACY_ACCESS_TOKEN_ACCEPT_UNTIL;
    assert.throws(() => getLegacyAccessTokenAcceptUntilMs(), /must be configured/);
  } finally {
    if (previous.node === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous.node;
    if (previous.cutoff === undefined) delete process.env.LEGACY_ACCESS_TOKEN_ACCEPT_UNTIL; else process.env.LEGACY_ACCESS_TOKEN_ACCEPT_UNTIL = previous.cutoff;
  }
});
