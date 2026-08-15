/**
 * Run a sensitive API action under a five-minute step-up grant.
 * Opens the dialog when AUTH_STEP_UP_REQUIRED is returned; retries only when safe.
 *
 * Shared orchestration seam (Task 11): pages must not invent divergent pending/retry logic.
 */
import { apiV2, type ApiV2RequestConfig } from '../api/index.ts';
import {
  applyStepUpGrantHeader,
  getStepUpGrant,
  isStepUpActionGroup,
  isStepUpRetrySafe,
  parseStepUpRequired,
  storeStepUpGrant,
  type StepUpActionGroup,
} from './stepUp.ts';
import { getAuthCoordinator } from './sessionRuntime.ts';

export const STEP_UP_AMBIGUOUS_STATUS_MESSAGE = 'Status belum dapat dipastikan';

export type StepUpRunner = {
  ensureGrant(actionGroup: StepUpActionGroup): Promise<string | null>;
  requestStepUp(actionGroup: StepUpActionGroup, password: string, otp: string): Promise<void>;
};

/** Descriptor for the single in-flight pending sensitive action. */
export type StepUpPendingAction = {
  actionGroup: StepUpActionGroup;
  /** SID captured when AUTH_STEP_UP_REQUIRED was observed. */
  sid: string;
  /**
   * Headers from the original attempt. Idempotency-Key is preserved verbatim on retry;
   * never invent a new key here (Task 12 owns key generation).
   */
  headers: Record<string, unknown>;
  /**
   * True when the 403 was the gateway requireStepUp rejection before proxying to Rust.
   * Node places requireStepUp before proxy for the closed inventory, so exact
   * AUTH_STEP_UP_REQUIRED is always gateway-local for those routes.
   */
  gatewayRejectedBeforeUpstream: boolean;
  /** Re-run the original action with current grant headers (no new Idempotency-Key). */
  execute: () => Promise<unknown>;
};

export type StepUpOrchestratorDeps = {
  getSid(): string | null;
  requestGrant(actionGroup: StepUpActionGroup, password: string, otp: string): Promise<void>;
  /** Optional: clock for tests. */
  nowSeconds?: () => number;
};

export type StepUpDialogSnapshot = {
  open: boolean;
  actionGroup: StepUpActionGroup | null;
  error: string | null;
  busy: boolean;
};

export type StepUpListener = (snapshot: StepUpDialogSnapshot) => void;

export class StepUpCancelledError extends Error {
  readonly code = 'STEP_UP_CANCELLED';
  constructor(message = 'Verifikasi ulang dibatalkan') {
    super(message);
    this.name = 'StepUpCancelledError';
  }
}

export class StepUpAmbiguousError extends Error {
  readonly code = 'STEP_UP_AMBIGUOUS';
  constructor(message = STEP_UP_AMBIGUOUS_STATUS_MESSAGE) {
    super(message);
    this.name = 'StepUpAmbiguousError';
  }
}

export class StepUpBindingError extends Error {
  readonly code = 'STEP_UP_BINDING';
  constructor(message: string) {
    super(message);
    this.name = 'StepUpBindingError';
  }
}

/**
 * Production orchestration controller.
 * - At most one pending action.
 * - Pending action is bound to SID + server-selected action group.
 * - After grant issuance, auto-retry ONLY when gateway-rejected-before-Rust
 *   OR the original request already carries a stable Idempotency-Key.
 * - Ambiguous / reached-Rust / network / 5xx must not auto-retry.
 * - Cancellation clears password/OTP (via dialog close) and pending action.
 * - Logout / terminal / SID replacement must call cancel().
 */
export function createStepUpOrchestrator(deps: StepUpOrchestratorDeps) {
  let pending: StepUpPendingAction | null = null;
  let dialog: StepUpDialogSnapshot = {
    open: false,
    actionGroup: null,
    error: null,
    busy: false,
  };
  let ambiguousMessage: string | null = null;
  /** Resolvers waiting on dialog completion for the current run(). */
  let waiter: {
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
    actionGroup: StepUpActionGroup;
    sid: string;
  } | null = null;
  const listeners = new Set<StepUpListener>();
  const ambiguousListeners = new Set<(message: string | null) => void>();

  function emit() {
    const snap = { ...dialog };
    for (const listener of listeners) listener(snap);
  }

  function emitAmbiguous() {
    for (const listener of ambiguousListeners) listener(ambiguousMessage);
  }

  function setDialog(partial: Partial<StepUpDialogSnapshot>) {
    dialog = { ...dialog, ...partial };
    emit();
  }

  function setAmbiguous(message: string | null) {
    ambiguousMessage = message;
    emitAmbiguous();
  }

  function getPending(): StepUpPendingAction | null {
    return pending;
  }

  function getDialog(): StepUpDialogSnapshot {
    return { ...dialog };
  }

  function getAmbiguousMessage(): string | null {
    return ambiguousMessage;
  }

  function subscribe(listener: StepUpListener): () => void {
    listeners.add(listener);
    listener({ ...dialog });
    return () => {
      listeners.delete(listener);
    };
  }

  function subscribeAmbiguous(listener: (message: string | null) => void): () => void {
    ambiguousListeners.add(listener);
    listener(ambiguousMessage);
    return () => {
      ambiguousListeners.delete(listener);
    };
  }

  function clearPendingOnly() {
    pending = null;
  }

  /**
   * Cancel pending action and close dialog. Clears password/OTP via dialog unmount/open=false.
   * Rejects any in-flight run() waiter with StepUpCancelledError.
   */
  function cancel(_reason: string = 'cancelled'): void {
    const activeWaiter = waiter;
    waiter = null;
    pending = null;
    setDialog({ open: false, actionGroup: null, error: null, busy: false });
    if (activeWaiter) {
      activeWaiter.reject(new StepUpCancelledError());
    }
  }

  function clearAmbiguous(): void {
    setAmbiguous(null);
  }

  /**
   * Decide whether the pending action may be auto-retried after grant issuance.
   * Gateway-local AUTH_STEP_UP_REQUIRED and an already-present stable Idempotency-Key are safe;
   * reached-Rust/ambiguous mutations without a key remain investigation-only.
   */
  function canAutoRetry(action: StepUpPendingAction): boolean {
    const stableKey = Object.entries(action.headers).find(([name, value]) => {
      if (name.toLowerCase() !== 'idempotency-key') return false;
      if (typeof value === 'string') return value.trim().length > 0;
      return Array.isArray(value)
        && value.some((item) => typeof item === 'string' && item.trim().length > 0);
    });
    const keyValue = stableKey?.[1];
    const normalizedHeaders = typeof keyValue === 'string'
      ? { 'Idempotency-Key': keyValue }
      : Array.isArray(keyValue)
        ? { 'Idempotency-Key': keyValue.find((item) => typeof item === 'string' && item.trim().length > 0) }
        : action.headers;
    return isStepUpRetrySafe({
      gatewayRejectedBeforeUpstream: action.gatewayRejectedBeforeUpstream === true,
      headers: normalizedHeaders,
    });
  }

  /**
   * Execute a sensitive action. On exact AUTH_STEP_UP_REQUIRED for the expected
   * server-selected action group, automatically opens StepUpDialog with a pending
   * descriptor and waits for grant + safe retry / cancel / ambiguous refusal.
   */
  async function run<T>(
    actionGroup: StepUpActionGroup,
    execute: (config: ApiV2RequestConfig) => Promise<T>,
    baseConfig: ApiV2RequestConfig = {} as ApiV2RequestConfig,
  ): Promise<T> {
    if (!isStepUpActionGroup(actionGroup)) {
      throw new StepUpBindingError('Kelompok aksi tidak valid');
    }
    const sid = deps.getSid();
    if (!sid) {
      throw new StepUpBindingError('Sesi tidak valid untuk verifikasi ulang');
    }

    // One pending action only: cancel any prior incomplete flow before starting.
    if (pending || waiter || dialog.open) {
      cancel('replaced');
    }
    setAmbiguous(null);

    const headersSnapshot: Record<string, unknown> = {
      ...((baseConfig.headers as Record<string, unknown> | undefined) ?? {}),
    };

    const attempt = async (): Promise<T> => {
      const currentSid = deps.getSid();
      if (!currentSid || currentSid !== sid) {
        throw new StepUpBindingError('Sesi berubah; verifikasi ulang dibatalkan');
      }
      // Bind grant via orchestrator SID seam (not a second coordinator lookup) so tests
      // and production share one path. Never invent Idempotency-Key during retry.
      const mergedHeaders: Record<string, unknown> = {
        ...headersSnapshot,
        ...((baseConfig.headers as Record<string, unknown> | undefined) ?? {}),
      };
      const grant = getStepUpGrant(currentSid, actionGroup);
      const headers = grant
        ? applyStepUpGrantHeader(mergedHeaders, grant.token)
        : mergedHeaders;
      const config = {
        ...baseConfig,
        headers,
      } as ApiV2RequestConfig;
      return execute(config);
    };

    try {
      return await attempt();
    } catch (error) {
      const required = parseStepUpRequired(error);
      if (required === null) {
        throw error;
      }
      // Only auto-open for the exact expected server-selected group.
      if (required !== actionGroup) {
        throw error;
      }
      const currentSid = deps.getSid();
      if (!currentSid || currentSid !== sid) {
        throw new StepUpBindingError('Sesi berubah; verifikasi ulang dibatalkan');
      }

      const hasStableIdempotencyKey = Object.entries(headersSnapshot).some(([name, value]) => {
        if (name.toLowerCase() !== 'idempotency-key') return false;
        if (typeof value === 'string') return value.trim().length > 0;
        if (Array.isArray(value)) return value.some((item) => typeof item === 'string' && item.trim().length > 0);
        return false;
      });
      pending = {
        actionGroup,
        sid,
        headers: { ...headersSnapshot },
        // Stable Idempotency-Key means the 403 may have reached Rust (Site Config effective step-up).
        // Legacy no-key closed routes remain gateway-local.
        gatewayRejectedBeforeUpstream: !hasStableIdempotencyKey,
        execute: attempt as () => Promise<unknown>,
      };
      setDialog({ open: true, actionGroup, error: null, busy: false });

      return await new Promise<T>((resolve, reject) => {
        waiter = {
          resolve: (value) => resolve(value as T),
          reject,
          actionGroup,
          sid,
        };
      });
    }
  }

  /**
   * Dialog submit handler: issue grant, then retry only when safe.
   * Unsafe cases surface Indonesian ambiguous status and do not auto-retry.
   */
  async function completeWithCredentials(password: string, otp: string): Promise<void> {
    const action = pending;
    const activeWaiter = waiter;
    if (!action || !activeWaiter) {
      throw new StepUpBindingError('Tidak ada tindakan yang menunggu verifikasi');
    }
    if (action.actionGroup !== activeWaiter.actionGroup || action.sid !== activeWaiter.sid) {
      cancel('binding-mismatch');
      throw new StepUpBindingError('Ikatan sesi/aksi tidak cocok');
    }
    const currentSid = deps.getSid();
    if (!currentSid || currentSid !== action.sid) {
      cancel('sid-changed');
      throw new StepUpBindingError('Sesi berubah; verifikasi ulang dibatalkan');
    }

    setDialog({ busy: true, error: null });
    try {
      await deps.requestGrant(action.actionGroup, password, otp);
    } catch (err) {
      setDialog({ busy: false, error: stepUpErrorMessage(err) });
      throw err;
    }

    // Grant stored in memory. Decide retry policy.
    if (!canAutoRetry(action)) {
      // Task 12 absent: refuse auto-retry for ambiguous mutations.
      pending = null;
      waiter = null;
      setDialog({ open: false, actionGroup: null, error: null, busy: false });
      setAmbiguous(STEP_UP_AMBIGUOUS_STATUS_MESSAGE);
      activeWaiter.reject(new StepUpAmbiguousError());
      return;
    }

    try {
      const result = await action.execute();
      pending = null;
      waiter = null;
      setDialog({ open: false, actionGroup: null, error: null, busy: false });
      activeWaiter.resolve(result);
    } catch (err) {
      // Retry itself failed. If another step-up is required (expired grant), re-open
      // only for the same binding; otherwise surface the error without loops.
      const required = parseStepUpRequired(err);
      if (required === action.actionGroup) {
        const stillSid = deps.getSid();
        if (stillSid && stillSid === action.sid) {
          // Keep the same pending descriptor (same headers / idempotency key).
          setDialog({ open: true, actionGroup: action.actionGroup, error: null, busy: false });
          return;
        }
      }
      pending = null;
      waiter = null;
      setDialog({ open: false, actionGroup: null, error: null, busy: false });
      activeWaiter.reject(err);
    }
  }

  return {
    run,
    cancel,
    completeWithCredentials,
    getPending,
    getDialog,
    getAmbiguousMessage,
    clearAmbiguous,
    canAutoRetry,
    subscribe,
    subscribeAmbiguous,
    /** Test seam: force a pending descriptor without a live HTTP round-trip. */
    __setPendingForTest(action: StepUpPendingAction | null) {
      pending = action;
      if (action) {
        setDialog({ open: true, actionGroup: action.actionGroup, error: null, busy: false });
      } else {
        setDialog({ open: false, actionGroup: null, error: null, busy: false });
      }
    },
    clearPendingOnly,
  };
}

export type StepUpOrchestrator = ReturnType<typeof createStepUpOrchestrator>;

/**
 * Process-wide orchestrator used by pages via useStepUpOrchestration.
 * Logout / terminal / SID replacement must cancel this instance.
 */
let sharedOrchestrator: StepUpOrchestrator | null = null;

function buildSharedOrchestrator(): StepUpOrchestrator {
  return createStepUpOrchestrator({
    getSid: () => getAuthCoordinator()?.getSessionSid() ?? null,
    requestGrant: requestStepUpGrant,
  });
}

export function getSharedStepUpOrchestrator(): StepUpOrchestrator {
  if (!sharedOrchestrator) {
    sharedOrchestrator = buildSharedOrchestrator();
  }
  return sharedOrchestrator;
}

/** Cancel shared pending action and dialog (logout / terminal / SID replacement). */
export function cancelSharedStepUp(reason: string = 'session'): void {
  if (sharedOrchestrator) {
    sharedOrchestrator.cancel(reason);
  }
}

/** Test-only: reset the shared singleton. */
export function __resetSharedStepUpOrchestratorForTest(): void {
  if (sharedOrchestrator) {
    sharedOrchestrator.cancel('test-reset');
  }
  sharedOrchestrator = null;
}

export async function requestStepUpGrant(
  actionGroup: StepUpActionGroup,
  password: string,
  otp: string,
): Promise<void> {
  const sid = getAuthCoordinator()?.getSessionSid() ?? null;
  if (!sid) throw new Error('Sesi tidak valid untuk verifikasi ulang');
  const res = await apiV2.post(
    '/auth/step-up',
    { password, otp, actionGroup },
    { _skipAuthRefresh: true } as never,
  );
  const data = res.data as { grantToken?: string; actionGroup?: string; expiresAt?: number };
  if (!data.grantToken || !isStepUpActionGroup(data.actionGroup) || typeof data.expiresAt !== 'number') {
    throw new Error('Respons verifikasi ulang tidak valid');
  }
  // Cross-group response must never be stored under a different binding.
  if (data.actionGroup !== actionGroup) {
    throw new Error('Kelompok aksi tidak cocok dengan permintaan');
  }
  storeStepUpGrant({
    token: data.grantToken,
    actionGroup: data.actionGroup,
    sid,
    expiresAt: data.expiresAt,
  });
}

export function currentStepUpToken(actionGroup: StepUpActionGroup): string | null {
  const sid = getAuthCoordinator()?.getSessionSid() ?? null;
  if (!sid) return null;
  return getStepUpGrant(sid, actionGroup)?.token ?? null;
}

export function withStepUpHeaders(
  actionGroup: StepUpActionGroup,
  config: ApiV2RequestConfig = {} as ApiV2RequestConfig,
): ApiV2RequestConfig {
  const token = currentStepUpToken(actionGroup);
  if (!token) return config;
  return {
    ...config,
    headers: applyStepUpGrantHeader(config.headers as Record<string, unknown> | undefined, token) as never,
  };
}

export function stepUpErrorMessage(error: unknown): string {
  const response = (error as { response?: { data?: { error?: { message?: string; code?: string }; message?: string } } })?.response;
  const code = response?.data?.error?.code;
  const message = response?.data?.error?.message ?? response?.data?.message;
  if (code === 'REAUTH_PASSWORD_INVALID') return 'Password tidak valid';
  if (code === 'REAUTH_OTP_INVALID') return 'Kode OTP tidak valid';
  if (code === 'REAUTH_ATTEMPTS_EXHAUSTED') return 'Percobaan verifikasi terlalu banyak';
  if (code === 'AUTH_2FA_ENROLLMENT_REQUIRED') {
    return 'Aktifkan 2FA di menu Keamanan sebelum melanjutkan aksi sensitif';
  }
  if (typeof message === 'string' && message.trim()) return message;
  return 'Verifikasi ulang gagal';
}

export function isStepUpCancelled(error: unknown): boolean {
  return error instanceof StepUpCancelledError
    || (error as { code?: string; name?: string })?.code === 'STEP_UP_CANCELLED'
    || (error as { name?: string })?.name === 'StepUpCancelledError';
}

export function isStepUpAmbiguous(error: unknown): boolean {
  return error instanceof StepUpAmbiguousError
    || (error as { code?: string; name?: string })?.code === 'STEP_UP_AMBIGUOUS'
    || (error as { name?: string })?.name === 'StepUpAmbiguousError';
}

/**
 * Map orchestration failures to user-facing Indonesian copy for page feedback.
 * Cancelled flows return null (silent). Ambiguous returns the fixed status string.
 */
export function stepUpActionErrorMessage(error: unknown, fallback: string): string | null {
  if (isStepUpCancelled(error)) return null;
  if (isStepUpAmbiguous(error)) return STEP_UP_AMBIGUOUS_STATUS_MESSAGE;
  const response = (error as { response?: { data?: { error?: { message?: string }; message?: string } } })?.response;
  const message = response?.data?.error?.message ?? response?.data?.message;
  if (typeof message === 'string' && message.trim()) return message;
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}

export { parseStepUpRequired, isStepUpRetrySafe, isStepUpActionGroup };
export type { StepUpActionGroup };
