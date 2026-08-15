/**
 * Pure client-side contracts for the revisioned slider management API.
 *
 * This module intentionally has no React, Axios, DOM, or browser-only dependencies.  It can be
 * used by the admin UI as well as by Node contract tests.  The backend marker is a capability
 * boundary: an unmarked/legacy response is useful for rendering, but never authorizes a write.
 */

export const SLIDER_MUTATION_CONTRACT = 'slider-revision-v1' as const;

export type SliderAction = 'create' | 'update' | 'archive' | 'restore' | 'reorder';

export type SliderLimits = {
  total: number;
  active: number;
  currentTotal: number;
  currentActive: number;
  remainingTotal: number;
  remainingActive: number;
};

export type SliderAdminItem = {
  _id: string;
  name: string;
  image: string;
  link: string;
  sortOrder: number;
  status: boolean;
  /** Present on revisioned admin snapshots; legacy arrays may omit it. */
  lifecycle?: string;
  createdAt?: string;
  updatedAt?: string;
  archivedAt?: string | null;
  archivedBy?: string | null;
  [key: string]: unknown;
};

export type SliderAdminSnapshot = {
  versioned: true;
  mutationEnabled: true;
  mutationContract: typeof SLIDER_MUTATION_CONTRACT;
  revision: number;
  sliders: SliderAdminItem[];
  limits: SliderLimits;
};

export type SliderLegacyReadOnlySnapshot = {
  versioned: false;
  mutationEnabled: false;
  /** Legacy responses do not have a trustworthy revision; zero is a display fallback only. */
  revision: number;
  sliders: SliderAdminItem[];
  limits?: SliderLimits;
  mutationContract?: unknown;
};

export type ParsedSliderAdminSnapshot = SliderAdminSnapshot | SliderLegacyReadOnlySnapshot;

export type SliderCryptoSource = {
  randomUUID: () => string;
};

export type SliderIntent = {
  key: string;
  action: SliderAction;
  targetId: string | null;
  expectedRevision: number;
  payload: unknown;
};

export type SliderRequest = {
  method: 'POST' | 'PUT';
  url: string;
  body: Record<string, unknown>;
  headers: { 'Idempotency-Key': string };
};

export type SliderConflictKind = 'draft-only' | 'server-only' | 'conflict' | 'unchanged';

export type SliderVersionConflict = {
  expectedRevision: number | null;
  currentRevision: number;
  currentSnapshot: ParsedSliderAdminSnapshot;
};

const ACTIONS: readonly SliderAction[] = ['create', 'update', 'archive', 'restore', 'reorder'];
const INTENT_KEY_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSafeRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item)) as T;
  }
  if (isRecord(value)) {
    const clone: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) clone[key] = cloneValue(item);
    return clone as T;
  }
  return value;
}

function isSliderLimits(value: unknown): value is SliderLimits {
  if (!isRecord(value)) return false;
  return (
    isSafeRevision(value.total)
    && isSafeRevision(value.active)
    && isSafeRevision(value.currentTotal)
    && isSafeRevision(value.currentActive)
    && isSafeRevision(value.remainingTotal)
    && isSafeRevision(value.remainingActive)
  );
}

/**
 * Validate the stable fields needed by mutation conflict/rebase UI.  Timestamp/archive fields
 * are optional for compatibility with older read snapshots; mutation is still gated by the
 * complete top-level shape and exact capability marker.
 */
function isLegacySliderAdminItem(value: unknown): value is SliderAdminItem {
  if (!isRecord(value)) return false;
  return (
    typeof value._id === 'string'
    && value._id.trim().length > 0
    && typeof value.name === 'string'
    && typeof value.image === 'string'
    && typeof value.link === 'string'
    && isSafeRevision(value.sortOrder)
    && typeof value.status === 'boolean'
    && (value.createdAt === undefined || typeof value.createdAt === 'string')
    && (value.updatedAt === undefined || typeof value.updatedAt === 'string')
    && (value.archivedAt === undefined || value.archivedAt === null || typeof value.archivedAt === 'string')
    && (value.archivedBy === undefined || value.archivedBy === null || typeof value.archivedBy === 'string')
  );
}

function isSliderAdminItem(value: unknown): value is SliderAdminItem {
  return isLegacySliderAdminItem(value) && typeof value.lifecycle === 'string';
}

function readOnlySnapshot(
  sliders: SliderAdminItem[] = [],
  revision = 0,
  limits?: SliderLimits,
  mutationContract?: unknown,
): SliderLegacyReadOnlySnapshot {
  return {
    versioned: false,
    mutationEnabled: false,
    revision: isSafeRevision(revision) ? revision : 0,
    sliders: cloneValue(sliders),
    ...(limits ? { limits: cloneValue(limits) } : {}),
    ...(mutationContract !== undefined ? { mutationContract: cloneValue(mutationContract) } : {}),
  };
}

/**
 * Parse an admin read response without ever upgrading an unknown/legacy response to writable.
 * Arrays are the old public/read shape.  A versioned response becomes writable only when every
 * capability-bearing field and the snapshot's structural fields are valid.
 */
export function parseSliderAdminSnapshot(input: unknown): ParsedSliderAdminSnapshot {
  if (Array.isArray(input)) {
    // Legacy arrays are intentionally preserved as read-only data.  Invalid members remain
    // renderable data but cannot accidentally become a mutation-capable snapshot.
    const sliders = input.filter(isLegacySliderAdminItem).map((item) => cloneValue(item));
    return readOnlySnapshot(sliders);
  }
  if (!isRecord(input)) return readOnlySnapshot();

  const markerPresent = Object.prototype.hasOwnProperty.call(input, 'mutationContract');
  const revisionPresent = Object.prototype.hasOwnProperty.call(input, 'revision');
  const marker = input.mutationContract;
  const revision = input.revision;
  const slidersRaw = input.sliders;
  const limitsRaw = input.limits;
  const slidersValid = Array.isArray(slidersRaw) && slidersRaw.every(isSliderAdminItem);
  const limitsValid = isSliderLimits(limitsRaw);
  const revisionValid = !revisionPresent || isSafeRevision(revision);
  const safeSliders = slidersValid
    ? (slidersRaw as SliderAdminItem[]).map((item) => cloneValue(item))
    : [];
  const safeLimits = limitsValid ? cloneValue(limitsRaw as SliderLimits) : undefined;
  const safeRevision = revisionValid && isSafeRevision(revision) ? revision : 0;

  if (
    marker === SLIDER_MUTATION_CONTRACT
    && revisionValid
    && isSafeRevision(revision)
    && slidersValid
    && limitsValid
  ) {
    return {
      versioned: true,
      mutationEnabled: true,
      mutationContract: SLIDER_MUTATION_CONTRACT,
      revision,
      sliders: safeSliders,
      limits: safeLimits as SliderLimits,
    };
  }

  // Keep valid read data available, but preserve a failed marker/revision as read-only.  In
  // particular, malformed present values are never treated as a legacy omission that enables
  // writes later in the call chain.
  return readOnlySnapshot(
    safeSliders,
    safeRevision,
    safeLimits,
    markerPresent ? marker : undefined,
  );
}

function defaultCryptoSource(): SliderCryptoSource {
  const candidate = (globalThis as { crypto?: Partial<SliderCryptoSource> } | undefined)?.crypto;
  if (!candidate || typeof candidate.randomUUID !== 'function') {
    throw new Error('Web Crypto tidak tersedia untuk membuat Idempotency-Key slider');
  }
  return { randomUUID: () => candidate.randomUUID!() };
}

function readUuid(cryptoSource: SliderCryptoSource | (() => string)): string {
  const value = typeof cryptoSource === 'function'
    ? cryptoSource()
    : cryptoSource?.randomUUID?.();
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Gagal membuat Idempotency-Key slider');
  }
  return value;
}

function validateAction(action: unknown): asserts action is SliderAction {
  if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) {
    throw new Error('Aksi slider tidak valid');
  }
}

function normalizeTarget(action: SliderAction, targetId: unknown): string | null {
  const target = targetId == null ? null : targetId;
  if (target !== null && typeof target !== 'string') {
    throw new Error('Target slider tidak valid');
  }
  if (target !== null && target.trim().length === 0) {
    throw new Error('Target slider tidak valid');
  }
  const needsTarget = action === 'update' || action === 'archive' || action === 'restore';
  if (needsTarget && target === null) throw new Error('Target slider wajib diisi');
  if (!needsTarget && target !== null) throw new Error('Target slider tidak berlaku untuk aksi ini');
  return target;
}

function makeSliderKey(cryptoSource?: SliderCryptoSource | (() => string)): string {
  const source = cryptoSource ?? defaultCryptoSource();
  const key = `slider_${readUuid(source)}`;
  if (!INTENT_KEY_PATTERN.test(key)) {
    throw new Error('Gagal membuat Idempotency-Key slider');
  }
  return key;
}

export function createSliderIntent(
  action: SliderAction,
  targetId: string | null | undefined,
  expectedRevision: number,
  payload: unknown,
  cryptoSource?: SliderCryptoSource | (() => string),
): SliderIntent {
  validateAction(action);
  if (!isSafeRevision(expectedRevision)) {
    throw new Error('expectedRevision slider tidak valid');
  }
  const target = normalizeTarget(action, targetId);
  return {
    key: makeSliderKey(cryptoSource),
    action,
    targetId: target,
    expectedRevision,
    payload: cloneValue(payload),
  };
}

export function retrySameSliderIntent(intent: SliderIntent): SliderIntent {
  // This operation is deliberately key-free: it represents the exact same server operation
  // after step-up/auth refresh, so changing the key would defeat the permanent claim fence.
  return {
    key: intent.key,
    action: intent.action,
    targetId: intent.targetId,
    expectedRevision: intent.expectedRevision,
    payload: cloneValue(intent.payload),
  };
}

export function rebaseSliderIntent(
  intent: SliderIntent,
  nextRevision: number,
  payload: unknown,
  cryptoSource?: SliderCryptoSource | (() => string),
): SliderIntent {
  // A revision rebase is a new server operation and must receive a new permanent claim key.
  return createSliderIntent(intent.action, intent.targetId, nextRevision, payload, cryptoSource);
}

function requestTarget(intent: SliderIntent): string {
  if (!intent.targetId) throw new Error('Target slider wajib diisi');
  return encodeURIComponent(intent.targetId);
}

function requestPayload(intent: SliderIntent): unknown {
  return cloneValue(intent.payload);
}

/** Build only the revisioned wire envelopes; no legacy flat mutation payload is emitted. */
export function createSliderRequest(intent: SliderIntent): SliderRequest {
  if (!INTENT_KEY_PATTERN.test(intent.key)) throw new Error('Idempotency-Key slider tidak valid');
  if (!isSafeRevision(intent.expectedRevision)) throw new Error('expectedRevision slider tidak valid');
  validateAction(intent.action);
  const headers = { 'Idempotency-Key': intent.key } as const;

  switch (intent.action) {
    case 'create':
      return {
        method: 'POST',
        url: '/sliders/admin/create',
        body: { expectedRevision: intent.expectedRevision, slider: requestPayload(intent) },
        headers,
      };
    case 'update':
      return {
        method: 'PUT',
        url: `/sliders/admin/${requestTarget(intent)}`,
        body: { expectedRevision: intent.expectedRevision, changes: requestPayload(intent) },
        headers,
      };
    case 'archive':
      return {
        method: 'POST',
        url: `/sliders/admin/${requestTarget(intent)}/archive`,
        body: { expectedRevision: intent.expectedRevision },
        headers,
      };
    case 'restore':
      return {
        method: 'POST',
        url: `/sliders/admin/${requestTarget(intent)}/restore`,
        body: { expectedRevision: intent.expectedRevision },
        headers,
      };
    case 'reorder':
      return {
        method: 'PUT',
        url: '/sliders/admin/reorder',
        body: { expectedRevision: intent.expectedRevision, orders: requestPayload(intent) },
        headers,
      };
  }
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => sameValue(value, right[index]));
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    return [...keys].every((key) => sameValue(left[key], right[key]));
  }
  return false;
}

export function classifySliderConflict(
  base: Record<string, unknown>,
  draft: Record<string, unknown>,
  server: Record<string, unknown>,
): Record<string, SliderConflictKind> {
  const keys = new Set([...Object.keys(base), ...Object.keys(draft), ...Object.keys(server)]);
  const result: Record<string, SliderConflictKind> = {};
  for (const key of keys) {
    const baseValue = base[key];
    const draftValue = draft[key];
    const serverValue = server[key];
    // `hasOwn` makes absent-vs-undefined explicit while preserving normal JSON field behavior.
    const draftChanged = hasOwn(draft, key) !== hasOwn(base, key) || !sameValue(draftValue, baseValue);
    const serverChanged = hasOwn(server, key) !== hasOwn(base, key) || !sameValue(serverValue, baseValue);
    if (draftChanged && serverChanged && !sameValue(draftValue, serverValue)) {
      result[key] = 'conflict';
    } else if (serverChanged && !draftChanged) {
      result[key] = 'server-only';
    } else if (draftChanged && !serverChanged) {
      result[key] = 'draft-only';
    } else {
      result[key] = 'unchanged';
    }
  }
  return result;
}

function responseData(error: unknown): unknown {
  if (!isRecord(error)) return undefined;
  const response = error.response;
  if (!isRecord(response)) return undefined;
  return response.data;
}

function errorBody(error: unknown): Record<string, unknown> | null {
  const data = responseData(error);
  if (isRecord(data)) {
    if (isRecord(data.error)) return data.error;
    return data;
  }
  if (isRecord(error)) {
    if (isRecord(error.error)) return error.error;
    return error;
  }
  return null;
}

function errorCode(error: unknown): string | undefined {
  const body = errorBody(error);
  if (typeof body?.code === 'string') return body.code;
  const data = responseData(error);
  return isRecord(data) && typeof data.code === 'string' ? data.code : undefined;
}

function errorMessage(error: unknown): string | undefined {
  const body = errorBody(error);
  if (typeof body?.message === 'string' && body.message.trim()) return body.message;
  const data = responseData(error);
  if (isRecord(data) && typeof data.message === 'string' && data.message.trim()) return data.message;
  if (error instanceof Error && error.message.trim()) return error.message;
  if (isRecord(error) && typeof error.message === 'string' && error.message.trim()) return error.message;
  return undefined;
}

export function sliderErrorMessage(error: unknown): string {
  const code = errorCode(error);
  if (code === 'SLIDER_COMMIT_UNKNOWN') {
    return 'Status mutasi slider belum dapat dipastikan. Periksa snapshot terbaru dan audit sebelum membuat tindakan baru.';
  }
  if (code === 'SLIDER_VERSION_CONFLICT') {
    return errorMessage(error) ?? 'Daftar slider telah berubah';
  }
  if (code === 'AUTH_STEP_UP_REQUIRED') {
    return errorMessage(error) ?? 'Verifikasi ulang diperlukan untuk mengubah slider';
  }
  return errorMessage(error) ?? 'Gagal menyimpan slider.';
}

function bodyForConflict(error: unknown): Record<string, unknown> | null {
  const body = errorBody(error);
  return body;
}

export function parseSliderVersionConflict(error: unknown): SliderVersionConflict | null {
  const body = bodyForConflict(error);
  if (!body || body.code !== 'SLIDER_VERSION_CONFLICT') return null;
  const currentRevision = body.currentRevision;
  if (!isSafeRevision(currentRevision)) return null;
  const currentSnapshotRaw = body.currentSnapshot;
  if (currentSnapshotRaw === undefined) return null;
  const currentSnapshot = parseSliderAdminSnapshot(currentSnapshotRaw);
  // A malformed object is retained as a read-only empty snapshot by the parser.  Reject it here
  // because a conflict payload must include an authoritative snapshot to support safe rebase.
  if (!isRecord(currentSnapshotRaw) && !Array.isArray(currentSnapshotRaw)) return null;
  if (currentSnapshot.revision !== currentRevision) return null;
  const expectedRevision = isSafeRevision(body.expectedRevision) ? body.expectedRevision : null;
  return { expectedRevision, currentRevision, currentSnapshot };
}
