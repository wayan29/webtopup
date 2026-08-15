import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifySliderConflict,
  createSliderIntent,
  createSliderRequest,
  parseSliderAdminSnapshot,
  parseSliderVersionConflict,
  rebaseSliderIntent,
  retrySameSliderIntent,
  sliderErrorMessage,
} from './sliderManagement.ts';

const fixtureLimits = {
  total: 20,
  active: 8,
  currentTotal: 0,
  currentActive: 0,
  remainingTotal: 20,
  remainingActive: 8,
};

const fixtureSlider = {
  _id: '507f1f77bcf86cd799439011',
  name: 'Promo',
  image: '/uploads/covers/1710000000000-deadbeef.webp',
  link: '/promo',
  sortOrder: 0,
  status: false,
  lifecycle: 'active',
  createdAt: '2026-08-13T00:00:00.000Z',
  updatedAt: '2026-08-13T00:00:00.000Z',
  archivedAt: null,
  archivedBy: null,
};

const fixedCrypto = (uuid: string) => ({ randomUUID: () => uuid });

function errorEnvelope(code: string, message = 'Pesan error') {
  return { response: { data: { error: { code, message } } } };
}

test('legacy array is read-only and exact capability enables writes', () => {
  const legacy = parseSliderAdminSnapshot([]);
  assert.equal(legacy.versioned, false);
  assert.equal(legacy.mutationEnabled, false);
  const current = parseSliderAdminSnapshot({
    mutationContract: 'slider-revision-v1',
    revision: 4,
    sliders: [],
    limits: fixtureLimits,
  });
  assert.equal(current.versioned, true);
  assert.equal(current.mutationEnabled, true);
  assert.equal(current.revision, 4);
});

test('malformed present revision, marker, and snapshot shape fail closed', () => {
  const base = { sliders: [], limits: fixtureLimits };
  assert.equal(parseSliderAdminSnapshot({ ...base, mutationContract: 'slider-revision-v1', revision: '4' }).mutationEnabled, false);
  assert.equal(parseSliderAdminSnapshot({ ...base, mutationContract: 'slider-revision-v2', revision: 4 }).mutationEnabled, false);
  assert.equal(parseSliderAdminSnapshot({ ...base, mutationContract: null, revision: 4 }).mutationEnabled, false);
  assert.equal(parseSliderAdminSnapshot({ ...base, mutationContract: 'slider-revision-v1', revision: -1 }).mutationEnabled, false);
  assert.equal(parseSliderAdminSnapshot({ ...base, mutationContract: 'slider-revision-v1', revision: 1.5 }).mutationEnabled, false);
  assert.equal(parseSliderAdminSnapshot({ mutationContract: 'slider-revision-v1', revision: 1, sliders: {} as unknown, limits: fixtureLimits }).mutationEnabled, false);
  assert.equal(parseSliderAdminSnapshot({ mutationContract: 'slider-revision-v1', revision: 1, sliders: [], limits: { ...fixtureLimits, total: '20' } }).mutationEnabled, false);
});

test('same intent survives step-up and replay but rebase creates a new key', () => {
  const intent = createSliderIntent(
    'update',
    fixtureSlider._id,
    4,
    { name: 'Promo Baru' },
    fixedCrypto('11111111-1111-4111-8111-111111111111'),
  );
  assert.equal(intent.key, 'slider_11111111-1111-4111-8111-111111111111');
  const retry = retrySameSliderIntent(intent);
  assert.equal(retry.key, intent.key);
  assert.equal(retry.action, intent.action);
  assert.equal(retry.targetId, intent.targetId);
  assert.equal(retry.expectedRevision, intent.expectedRevision);
  assert.deepEqual(retry.payload, intent.payload);

  const rebased = rebaseSliderIntent(
    intent,
    5,
    { name: 'Promo Rebased' },
    fixedCrypto('22222222-2222-4222-8222-222222222222'),
  );
  assert.notEqual(rebased.key, intent.key);
  assert.equal(rebased.key, 'slider_22222222-2222-4222-8222-222222222222');
  assert.equal(rebased.expectedRevision, 5);
  assert.deepEqual(rebased.payload, { name: 'Promo Rebased' });
});

test('request builder emits the revisioned wire envelope for every action', () => {
  const crypto = fixedCrypto('33333333-3333-4333-8333-333333333333');
  const create = createSliderIntent('create', null, 4, {
    name: 'Promo', image: fixtureSlider.image, link: '/promo', status: false,
  }, crypto);
  assert.deepEqual(createSliderRequest(create), {
    method: 'POST',
    url: '/sliders/admin/create',
    body: {
      expectedRevision: 4,
      slider: { name: 'Promo', image: fixtureSlider.image, link: '/promo', status: false },
    },
    headers: { 'Idempotency-Key': create.key },
  });

  const update = createSliderIntent('update', fixtureSlider._id, 4, { status: true }, crypto);
  assert.deepEqual(createSliderRequest(update), {
    method: 'PUT',
    url: `/sliders/admin/${fixtureSlider._id}`,
    body: { expectedRevision: 4, changes: { status: true } },
    headers: { 'Idempotency-Key': update.key },
  });

  const archive = createSliderIntent('archive', fixtureSlider._id, 4, {}, crypto);
  assert.deepEqual(createSliderRequest(archive), {
    method: 'POST',
    url: `/sliders/admin/${fixtureSlider._id}/archive`,
    body: { expectedRevision: 4 },
    headers: { 'Idempotency-Key': archive.key },
  });

  const restore = createSliderIntent('restore', fixtureSlider._id, 4, {}, crypto);
  assert.deepEqual(createSliderRequest(restore), {
    method: 'POST',
    url: `/sliders/admin/${fixtureSlider._id}/restore`,
    body: { expectedRevision: 4 },
    headers: { 'Idempotency-Key': restore.key },
  });

  const reorder = createSliderIntent('reorder', null, 4, [
    { id: fixtureSlider._id, sortOrder: 0 },
  ], crypto);
  assert.deepEqual(createSliderRequest(reorder), {
    method: 'PUT',
    url: '/sliders/admin/reorder',
    body: { expectedRevision: 4, orders: [{ id: fixtureSlider._id, sortOrder: 0 }] },
    headers: { 'Idempotency-Key': reorder.key },
  });
  assert.equal('changes' in createSliderRequest(create).body, false);
  assert.equal('slider' in createSliderRequest(update).body, false);
});

test('nested errors and version conflicts expose the authoritative snapshot', () => {
  const currentSnapshot = {
    mutationContract: 'slider-revision-v1',
    revision: 9,
    sliders: [fixtureSlider],
    limits: fixtureLimits,
  };
  const error = {
    response: {
      data: {
        error: {
          code: 'SLIDER_VERSION_CONFLICT',
          message: 'Daftar slider telah berubah',
          expectedRevision: 8,
          currentRevision: 9,
          currentSnapshot,
        },
      },
    },
  };
  const conflict = parseSliderVersionConflict(error);
  assert.ok(conflict);
  assert.equal(conflict.expectedRevision, 8);
  assert.equal(conflict.currentRevision, 9);
  assert.equal(conflict.currentSnapshot.mutationEnabled, true);
  assert.equal(conflict.currentSnapshot.revision, 9);
  assert.equal(sliderErrorMessage(error), 'Daftar slider telah berubah');
  assert.equal(sliderErrorMessage({ response: { data: { code: 'SLIDER_PAYLOAD_INVALID', message: 'Payload tidak valid' } } }), 'Payload tidak valid');
  assert.equal(parseSliderVersionConflict(errorEnvelope('SLIDER_PAYLOAD_INVALID')), null);
});

test('commit unknown maps to investigation status and never retry copy', () => {
  const message = sliderErrorMessage(errorEnvelope('SLIDER_COMMIT_UNKNOWN'));
  assert.match(message, /belum dapat dipastikan/i);
  assert.doesNotMatch(message, /coba lagi|retry/i);
});

test('three-way conflict classification distinguishes draft-only, server-only, conflict, and unchanged', () => {
  const base = { name: 'A', image: 'a.webp', link: '/a', status: false };
  const draft = { name: 'B', image: 'a.webp', link: '/same', status: true };
  const server = { name: 'C', image: 'b.webp', link: '/same', status: false };
  const kinds = classifySliderConflict(base, draft, server);
  assert.equal(kinds.name, 'conflict');
  assert.equal(kinds.image, 'server-only');
  assert.equal(kinds.link, 'unchanged');
  assert.equal(kinds.status, 'draft-only');
});
