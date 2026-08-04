import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldStartStaffActivity } from '../../../client/src/auth/activity.ts';

test('authenticated staff activity starts locally without requiring a broadcast SID', () => {
  assert.equal(shouldStartStaffActivity('cs', 'authenticated'), true);
  assert.equal(shouldStartStaffActivity('admin', 'authenticated'), true);
  assert.equal(shouldStartStaffActivity('member', 'authenticated'), false);
  assert.equal(shouldStartStaffActivity('cs', 'initializing'), false);
});
