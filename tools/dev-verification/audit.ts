import fs from 'node:fs/promises';
import path from 'node:path';
import { assertNoSecrets } from './redact.ts';
import type { VerificationConfig } from './types.ts';

export async function auditRetainedReports(config: VerificationConfig): Promise<void> {
  const directory = path.join(config.stateDir, 'reports');
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    assertNoSecrets(await fs.readFile(path.join(directory, entry.name), 'utf8'));
  }
}
