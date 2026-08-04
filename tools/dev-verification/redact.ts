import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { VerificationResultStatus } from './types.ts';

const REDACTED = '[REDACTED]';
const SECRET_KEY = /(?:authorization|set[-_]?cookie|cookie|password|passwd|jwt|access[-_]?token|refresh|recovery|csrf|otp|secret|digest|ciphertext|nonce|private[-_]?key)/iu;
const SECRET_TEXT = [
  /\bAuthorization\s*:\s*(?:Bearer|Basic)\s+\S+/giu,
  /\b(?:Set-Cookie|Cookie)\s*:\s*[^\r\n]+/giu,
  /mongodb(?:\+srv)?:\/\/[^\s/@:]+:[^\s/@]+@[^\s]+/giu,
  /\b(?:password|passwd|token|refresh(?:Token)?|recovery(?:Code)?|csrf(?:Token)?|otp|secret|digest|ciphertext|nonce)\s*[=:]\s*[^\s,;]+/giu,
  /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/giu,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu,
];

const redactText = (text: string): string => SECRET_TEXT.reduce((value, pattern) => value.replace(pattern, REDACTED), text);

export function redact(value: unknown, key = ''): unknown {
  if (SECRET_KEY.test(key)) return REDACTED;
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([nestedKey, nestedValue]) => [nestedKey, redact(nestedValue, nestedKey)]));
  return value;
}

export function assertNoSecrets(text: string): void {
  let structuralSecret = false;
  try {
    const parsed = JSON.parse(text) as unknown;
    structuralSecret = JSON.stringify(redact(parsed)) !== JSON.stringify(parsed);
  } catch { /* non-JSON text is checked by patterns below */ }
  if (structuralSecret || redactText(text) !== text || /-----BEGIN [^-]*PRIVATE KEY-----/iu.test(text)) throw new Error('evidence contains prohibited secret material');
}

export async function writeEvidenceAtomic(destination: string, evidence: unknown): Promise<VerificationResultStatus> {
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  let temporary: string | undefined;
  try {
    const compact = JSON.stringify(evidence);
    if (compact === undefined) throw new Error('evidence is not serializable');
    const materialized = JSON.parse(compact) as unknown;
    if (JSON.stringify(redact(materialized)) !== compact) throw new Error('evidence contains prohibited secret material');
    const serialized = `${JSON.stringify(materialized, null, 2)}\n`;
    assertNoSecrets(serialized);
    temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(serialized); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, destination);
    temporary = undefined;
    return 'LOCAL DEV VERIFIED';
  } catch {
    if (temporary) await fs.rm(temporary, { force: true });
    return 'LOCAL DEV FAILED';
  }
}
