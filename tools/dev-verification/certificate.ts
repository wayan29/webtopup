import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';

/**
 * Chromium's SPKI allowlist scopes the local exception to the exact generated certificate key.
 * It does not disable certificate validation globally and contains no private key material.
 */
export function verificationCertificateSpki(root: string): string {
  const certificatePath = path.join(root, '.dev-verification', 'certs', 'webtopup.local.test.pem');
  const certificate = new X509Certificate(fs.readFileSync(certificatePath));
  return crypto.createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
}
