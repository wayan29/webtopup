'use strict';

const AUDIT_REDACTION = '[redacted]';

const EXACT_SENSITIVE_AUDIT_KEYS = new Set([
  'password',
  'currentpassword',
  'newpassword',
  'confirmpassword',
  'pin',
  'merchantpin',
  'transactionpin',
  'securitypin',
  'apikey',
  'secret',
  'vendorsecret',
  'twofactorsecret',
  'twofactorpendingsecret',
  'otp',
  'code',
  'token',
  'authorization',
  'cookie',
  'csrftoken',
  'xcsrftoken',
  'accesstoken',
  'refreshtoken',
  'recoverytoken',
  'ciphertext',
  'nonce',
  'digest',
  'sessiontokenhashsecret',
]);

function normalizeAuditSecretKey(key) {
  return String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function isSensitiveAuditSecretKey(key) {
  const normalized = normalizeAuditSecretKey(key);
  return EXACT_SENSITIVE_AUDIT_KEYS.has(normalized)
    || /(token|password|secret|apikey|authorization|cookie|ciphertext|otp|csrf|nonce|digest)/i.test(normalized);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  if (value instanceof Date) return false;
  if (Buffer.isBuffer(value)) return false;
  if (typeof value._bsontype === 'string') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function redactAuditMetadata(value, seen = new WeakSet()) {
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      const error = new Error('cyclic audit metadata is unsupported');
      error.code = 'AUDIT_METADATA_CYCLE';
      throw error;
    }
    seen.add(value);
    let affectedFields = 0;
    const next = value.map((entry) => {
      const result = redactAuditMetadata(entry, seen);
      affectedFields += result.affectedFields;
      return result.value;
    });
    seen.delete(value);
    return { value: next, affectedFields };
  }

  if (isPlainObject(value)) {
    if (seen.has(value)) {
      const error = new Error('cyclic audit metadata is unsupported');
      error.code = 'AUDIT_METADATA_CYCLE';
      throw error;
    }
    seen.add(value);
    let affectedFields = 0;
    const next = {};
    for (const [key, entry] of Object.entries(value)) {
      if (isSensitiveAuditSecretKey(key)) {
        if (entry !== AUDIT_REDACTION) {
          affectedFields += 1;
        }
        next[key] = AUDIT_REDACTION;
        continue;
      }
      const result = redactAuditMetadata(entry, seen);
      affectedFields += result.affectedFields;
      next[key] = result.value;
    }
    seen.delete(value);
    return { value: next, affectedFields };
  }

  return { value, affectedFields: 0 };
}

module.exports = {
  AUDIT_REDACTION,
  normalizeAuditSecretKey,
  isSensitiveAuditSecretKey,
  redactAuditMetadata,
};
