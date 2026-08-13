export type SettingsFormLike = Record<string, unknown>;

export type SiteConfigIntent = {
  key: string;
  expectedRevision: number;
  changes: Record<string, unknown>;
};

export type ConflictKind = 'server-only' | 'draft-only' | 'conflict';

export function parseAdminSettingsResponse(input: unknown): {
  form: SettingsFormLike;
  revision: number;
  versioned: boolean;
} {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Respons pengaturan tidak valid');
  }
  const record = input as Record<string, unknown>;
  const revisionRaw = record.revision;
  const form: SettingsFormLike = { ...record };
  delete form.revision;
  if (revisionRaw === undefined) {
    return { form, revision: 0, versioned: false };
  }
  if (typeof revisionRaw !== 'number' || !Number.isInteger(revisionRaw) || revisionRaw < 0) {
    throw new Error('Revisi pengaturan tidak valid');
  }
  return { form, revision: revisionRaw, versioned: true };
}

export function createSiteConfigSaveRequest(
  versioned: boolean,
  intent: SiteConfigIntent,
): { body: Record<string, unknown>; headers: Record<string, string> } {
  const headers = { 'Idempotency-Key': intent.key };
  if (versioned) {
    return {
      body: {
        expectedRevision: intent.expectedRevision,
        changes: intent.changes,
      },
      headers,
    };
  }
  return { body: { ...intent.changes }, headers };
}

export function createChangedPayload(
  form: SettingsFormLike,
  lastSaved: SettingsFormLike,
): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(form)) {
    if (key === 'revision' || key === 'refIdSample' || key === 'invoiceSample') continue;
    if (value !== lastSaved[key]) changes[key] = value;
  }
  return changes;
}

export function createSiteConfigIntent(
  expectedRevision: number,
  changes: Record<string, unknown>,
  cryptoSource: { randomUUID: () => string } = globalThis.crypto,
): SiteConfigIntent {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new Error('expectedRevision tidak valid');
  }
  if (!changes || Object.keys(changes).length === 0) {
    throw new Error('Tidak ada perubahan');
  }
  const uuid = cryptoSource.randomUUID().replace(/[^A-Za-z0-9._-]/g, '');
  const key = `sitecfg_${uuid}`.slice(0, 128);
  if (key.length < 8) {
    throw new Error('Gagal membuat Idempotency-Key');
  }
  return { key, expectedRevision, changes: { ...changes } };
}

export function retrySameIntent(intent: SiteConfigIntent): SiteConfigIntent {
  return { ...intent, changes: { ...intent.changes } };
}

export function rebaseAfterConflict(
  _intent: SiteConfigIntent,
  nextRevision: number,
  changes: Record<string, unknown>,
  cryptoSource: { randomUUID: () => string } = globalThis.crypto,
): SiteConfigIntent {
  return createSiteConfigIntent(nextRevision, changes, cryptoSource);
}

export function classifySettingsConflict(
  base: SettingsFormLike,
  draft: SettingsFormLike,
  server: SettingsFormLike,
): Record<string, ConflictKind> {
  const keys = new Set([...Object.keys(base), ...Object.keys(draft), ...Object.keys(server)]);
  const result: Record<string, ConflictKind> = {};
  for (const key of keys) {
    if (key === 'revision') continue;
    const baseValue = base[key];
    const draftValue = draft[key];
    const serverValue = server[key];
    const draftChanged = draftValue !== baseValue;
    const serverChanged = serverValue !== baseValue;
    if (draftChanged && serverChanged && draftValue !== serverValue) {
      result[key] = 'conflict';
    } else if (serverChanged && !draftChanged) {
      result[key] = 'server-only';
    } else if (draftChanged && !serverChanged) {
      result[key] = 'draft-only';
    }
  }
  return result;
}

export function invoiceRandomMin(type: unknown): number {
  return type === 'numeric' ? 10 : 8;
}

export function siteConfigErrorMessage(error: unknown): string {
  const response = (error as { response?: { data?: any; status?: number } })?.response;
  const data = response?.data;
  const code = data?.error?.code || data?.code;
  if (code === 'SETTINGS_COMMIT_UNKNOWN') {
    return 'Status penyimpanan belum dapat dipastikan. Periksa revisi terbaru dan log audit sebelum mencoba tindakan baru.';
  }
  if (code === 'SETTINGS_VERSION_CONFLICT') {
    return data?.error?.message || 'Pengaturan telah diubah oleh pengguna lain';
  }
  if (code === 'AUTH_STEP_UP_REQUIRED') {
    return 'Verifikasi ulang diperlukan untuk mengubah konfigurasi situs sensitif';
  }
  if (code === 'SETTINGS_TRANSACTIONS_UNAVAILABLE') {
    return data?.error?.message || 'Mutasi Site Config membutuhkan transaksi database';
  }
  if (typeof data?.message === 'string' && data.message.trim()) {
    return data.message;
  }
  if (typeof data?.error?.message === 'string' && data.error.message.trim()) {
    return data.error.message;
  }
  return 'Gagal menyimpan pengaturan.';
}

export function parseVersionConflict(error: unknown): {
  currentRevision: number;
  currentSettings: SettingsFormLike;
} | null {
  const data = (error as { response?: { data?: any } })?.response?.data;
  const body = data?.error || data;
  if (!body || body.code !== 'SETTINGS_VERSION_CONFLICT') return null;
  const currentRevision = body.currentRevision;
  const currentSettings = body.currentSettings;
  if (typeof currentRevision !== 'number' || !currentSettings || typeof currentSettings !== 'object') {
    return null;
  }
  const parsed = parseAdminSettingsResponse(currentSettings);
  return { currentRevision: parsed.revision, currentSettings: parsed.form };
}
