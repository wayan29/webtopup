/**
 * Memory-only step-up grant store and safe retry helpers (Task 11).
 * Grants are keyed by exact SID + action group. Never localStorage/sessionStorage/channel.
 */

export const STEP_UP_ACTION_GROUPS = [
  'finance.adjust_balance',
  'finance.refund',
  'finance.deposit_approval',
  'transactions.manual',
  'integrations.credentials',
  'team.manage_privileged',
  'team.reset_2fa',
  'security.sessions_all',
  'exports.sensitive',
  // Staff self-service credential changes (email/password).
  'security.password',
  // Site Config sensitive effective changes.
  'settings.sensitive',
] as const;

export type StepUpActionGroup = (typeof STEP_UP_ACTION_GROUPS)[number];

export type StepUpGrant = {
  token: string;
  actionGroup: StepUpActionGroup;
  sid: string;
  expiresAt: number; // unix seconds
};

type GrantKey = string;

const grants = new Map<GrantKey, StepUpGrant>();

function keyOf(sid: string, actionGroup: StepUpActionGroup): GrantKey {
  return `${sid}::${actionGroup}`;
}

export function isStepUpActionGroup(value: unknown): value is StepUpActionGroup {
  return typeof value === 'string' && (STEP_UP_ACTION_GROUPS as readonly string[]).includes(value);
}

export function clearAllStepUpGrants(): void {
  grants.clear();
}

export function clearStepUpGrantsForSid(sid: string): void {
  for (const k of [...grants.keys()]) {
    if (k.startsWith(`${sid}::`)) grants.delete(k);
  }
}

/** Drop every grant that does not match the current SID (logout / SID replacement). */
export function retainStepUpGrantsForSid(currentSid: string | null | undefined): void {
  if (!currentSid) {
    grants.clear();
    return;
  }
  for (const [k, g] of [...grants.entries()]) {
    if (g.sid !== currentSid) grants.delete(k);
  }
}

export function purgeExpiredStepUpGrants(nowSeconds: number = Math.floor(Date.now() / 1000)): void {
  for (const [k, g] of [...grants.entries()]) {
    if (g.expiresAt <= nowSeconds) grants.delete(k);
  }
}

export function storeStepUpGrant(grant: StepUpGrant): void {
  if (!isStepUpActionGroup(grant.actionGroup) || !grant.sid || !grant.token) return;
  grants.set(keyOf(grant.sid, grant.actionGroup), {
    token: grant.token,
    actionGroup: grant.actionGroup,
    sid: grant.sid,
    expiresAt: grant.expiresAt,
  });
}

export function getStepUpGrant(
  sid: string,
  actionGroup: StepUpActionGroup,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): StepUpGrant | null {
  const g = grants.get(keyOf(sid, actionGroup));
  if (!g) return null;
  if (g.sid !== sid || g.actionGroup !== actionGroup) {
    grants.delete(keyOf(sid, actionGroup));
    return null;
  }
  if (g.expiresAt <= nowSeconds) {
    grants.delete(keyOf(sid, actionGroup));
    return null;
  }
  return g;
}

export function invalidateStepUpGrant(sid: string, actionGroup: StepUpActionGroup): void {
  grants.delete(keyOf(sid, actionGroup));
}

/** Test/harness seam: never used for persistence. */
export function __debugStepUpGrantCount(): number {
  return grants.size;
}

export type StepUpErrorBody = {
  error?: { code?: string; message?: string; actionGroup?: string };
  code?: string;
  message?: string;
  actionGroup?: string;
};

export function parseStepUpRequired(error: unknown): StepUpActionGroup | null {
  const response = (error as { response?: { status?: number; data?: StepUpErrorBody } })?.response;
  if (!response || response.status !== 403) return null;
  const data = response.data;
  const code = data?.error?.code ?? data?.code;
  if (code !== 'AUTH_STEP_UP_REQUIRED') return null;
  const group = data?.error?.actionGroup ?? data?.actionGroup;
  if (isStepUpActionGroup(group)) return group;
  return null;
}

/**
 * Retry policy (Task 11, Task 12 not yet implemented):
 * - Retry only if the original request provably did not reach Rust (local 403 step-up
 *   rejection before proxy) OR the request already carries a stable Idempotency-Key.
 * - Do not auto-retry ambiguous mutations.
 */
export function isStepUpRetrySafe(config: {
  method?: string;
  headers?: Record<string, unknown> | unknown;
  /** Set when the client knows the rejection was gateway-local AUTH_STEP_UP_REQUIRED. */
  gatewayRejectedBeforeUpstream?: boolean;
}): boolean {
  if (config.gatewayRejectedBeforeUpstream === true) return true;
  const headers = config.headers as Record<string, unknown> | undefined;
  const entry = Object.entries(headers ?? {}).find(
    ([k]) => k.toLowerCase() === 'idempotency-key',
  );
  const key = typeof entry?.[1] === 'string' ? entry[1].trim() : '';
  return Boolean(key);
}

export function applyStepUpGrantHeader(
  headers: Record<string, unknown> | undefined,
  token: string,
): Record<string, unknown> {
  const next = { ...(headers ?? {}) };
  // Preserve existing Idempotency-Key if present; never invent a new one here.
  next['X-Step-Up-Token'] = token;
  return next;
}
