/**
 * Pure helpers for staff 2FA enrollment deadline UX.
 * Server enforcement remains the authority; these only advance client display/gate from a memory-only offset.
 */

export type EnrollmentClockUser = {
  role?: string | null;
  twoFactorEnabled?: boolean | null;
  twoFactorEnrollmentRequiredAt?: string | null;
  serverTime?: string | null;
};

export type EnrollmentRemainingCopy = {
  remainingMs: number | null;
  message: string | null;
  live: boolean;
};

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const STAFF_ROLES = new Set(['owner', 'admin', 'cs']);

/**
 * Canonical zoned ISO only (server contract):
 * full date-time plus trailing `Z` or explicit numeric offset (`±HH:MM`).
 * Rejects timezone-less, date-only, locale/noncanonical, and overflow dates
 * even when permissive Date.parse would normalize them.
 */
const CANONICAL_ZONED_ISO =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

export function parseAuthoritativeTimestamp(value: string | null | undefined): number | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const match = CANONICAL_ZONED_ISO.exec(trimmed);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const ms = Number((match[7] ?? '0').padEnd(3, '0'));
  const zone = match[8];

  if (
    month < 1
    || month > 12
    || day < 1
    || hour > 23
    || minute > 59
    || second > 59
    || ms > 999
  ) {
    return null;
  }

  let offsetMinutes = 0;
  if (zone !== 'Z') {
    const sign = zone[0] === '-' ? -1 : 1;
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return null;
    offsetMinutes = sign * (offsetHour * 60 + offsetMinute);
  }

  // Interpret civil fields in the declared zone, then convert to UTC epoch ms.
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second, ms) - offsetMinutes * 60_000;
  if (!Number.isFinite(utcMs)) return null;

  // Reject overflow dates Date.parse would otherwise normalize (e.g. Feb 30).
  const probe = new Date(utcMs + offsetMinutes * 60_000);
  if (
    probe.getUTCFullYear() !== year
    || probe.getUTCMonth() + 1 !== month
    || probe.getUTCDate() !== day
    || probe.getUTCHours() !== hour
    || probe.getUTCMinutes() !== minute
    || probe.getUTCSeconds() !== second
    || probe.getUTCMilliseconds() !== ms
  ) {
    return null;
  }

  return utcMs;
}

/**
 * Memory-only offset: parsedServerTime - clientNow.
 * Malformed/missing server time fails closed with null (do not invent browser authority).
 */
export function computeServerTimeOffsetMs(
  serverTime: string | null | undefined,
  clientNowMs: number,
): number | null {
  const serverMs = parseAuthoritativeTimestamp(serverTime);
  if (serverMs === null || !Number.isFinite(clientNowMs)) return null;
  return serverMs - clientNowMs;
}

/** Authoritative wall clock = client now + stored offset. Null offset fails closed. */
export function authoritativeNowMs(clientNowMs: number, serverTimeOffsetMs: number | null | undefined): number | null {
  if (serverTimeOffsetMs === null || serverTimeOffsetMs === undefined) return null;
  if (!Number.isFinite(serverTimeOffsetMs) || !Number.isFinite(clientNowMs)) return null;
  return clientNowMs + serverTimeOffsetMs;
}

export function isStaffEnrollmentSubject(user: EnrollmentClockUser | null | undefined): boolean {
  if (!user || typeof user.role !== 'string') return false;
  return STAFF_ROLES.has(user.role);
}

/**
 * Staff-only overdue gate.
 * Fail closed when offset/deadline cannot be parsed: treat as overdue for gate purposes
 * only when the subject still requires enrollment (enabled=false + deadline present + staff).
 * Members and enrolled staff are never gated.
 */
export function isEnrollmentOverdue(options: {
  user: EnrollmentClockUser | null | undefined;
  clientNowMs: number;
  serverTimeOffsetMs: number | null | undefined;
}): boolean {
  const { user, clientNowMs, serverTimeOffsetMs } = options;
  if (!user || user.twoFactorEnabled) return false;
  if (!isStaffEnrollmentSubject(user)) return false;
  const deadlineMs = parseAuthoritativeTimestamp(user.twoFactorEnrollmentRequiredAt);
  if (deadlineMs === null) return false;

  const now = authoritativeNowMs(clientNowMs, serverTimeOffsetMs);
  if (now === null) {
    // Fail closed: malformed/missing offset with a present deadline means do not trust browser clock.
    // Prefer routing to security setup rather than silently treating as not overdue.
    return true;
  }
  return now >= deadlineMs;
}

/** Remaining ms until deadline from advancing authoritative time; null when not applicable. */
export function enrollmentRemainingMs(options: {
  user: EnrollmentClockUser | null | undefined;
  clientNowMs: number;
  serverTimeOffsetMs: number | null | undefined;
}): number | null {
  const { user, clientNowMs, serverTimeOffsetMs } = options;
  if (!user || user.twoFactorEnabled) return null;
  if (!isStaffEnrollmentSubject(user)) return null;
  const deadlineMs = parseAuthoritativeTimestamp(user.twoFactorEnrollmentRequiredAt);
  if (deadlineMs === null) return null;
  const now = authoritativeNowMs(clientNowMs, serverTimeOffsetMs);
  if (now === null) return null;
  return deadlineMs - now;
}

/** Indonesian countdown copy + live-region flag (near expiry within 24h). */
export function formatEnrollmentRemainingMessage(remainingMs: number | null): EnrollmentRemainingCopy {
  if (remainingMs === null) {
    return { remainingMs: null, message: null, live: false };
  }
  if (remainingMs <= 0) {
    return {
      remainingMs,
      message: 'Batas aktivasi 2FA telah lewat. Aktifkan 2FA untuk melanjutkan.',
      live: true,
    };
  }
  const message =
    remainingMs >= DAY_MS
      ? `Aktifkan 2FA dalam ${Math.ceil(remainingMs / DAY_MS)} hari.`
      : `Aktifkan 2FA dalam ${Math.max(1, Math.ceil(remainingMs / HOUR_MS))} jam.`;
  return {
    remainingMs,
    message,
    live: remainingMs <= DAY_MS,
  };
}

/**
 * Dashboard reminder gate. Staff without 2FA and with a stored deadline are reminded once per
 * visit; `dismissed` is caller-owned per-mount state so leaving and returning shows it again.
 * An untrusted server clock fails closed to showing the reminder rather than hiding the duty.
 */
export function shouldShowEnrollmentReminder(options: {
  user: EnrollmentClockUser | null | undefined;
  clientNowMs: number;
  serverTimeOffsetMs: number | null | undefined;
  dismissed: boolean;
}): boolean {
  const { user, dismissed } = options;
  if (dismissed) return false;
  if (!user || user.twoFactorEnabled) return false;
  if (!isStaffEnrollmentSubject(user)) return false;
  return parseAuthoritativeTimestamp(user.twoFactorEnrollmentRequiredAt) !== null;
}

/**
 * Reminder copy. Unlike the banner variant this never returns null: the dialog is only rendered
 * when a reminder is due, so it must always have something actionable to say.
 */
export function formatEnrollmentReminderMessage(remainingMs: number | null): string {
  if (remainingMs === null) {
    return 'Aktifkan 2FA untuk mengamankan akun staf Anda.';
  }
  return formatEnrollmentRemainingMessage(remainingMs).message
    ?? 'Aktifkan 2FA untuk mengamankan akun staf Anda.';
}

/**
 * Delay until the next UI tick for countdown:
 * - exact deadline when remaining is finite and positive
 * - otherwise bounded minute cadence while still counting down
 * - 0 when already overdue so callers can force a immediate recompute
 */
export function nextEnrollmentUiDelayMs(remainingMs: number | null, minuteCadenceMs = 60_000): number | null {
  if (remainingMs === null) return null;
  if (remainingMs <= 0) return 0;
  if (remainingMs <= minuteCadenceMs) return remainingMs;
  return Math.min(minuteCadenceMs, remainingMs);
}

export type EnrollmentDeadlineTimerDeps = {
  now(): number;
  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(id: ReturnType<typeof setTimeout>): void;
  onTick(): void;
};

/**
 * Generation-guarded deadline + minute-cadence timer.
 * Stops/restarts on lifecycle changes; stale callbacks after stop/replace are no-ops.
 */
export function createEnrollmentDeadlineTimer(deps: EnrollmentDeadlineTimerDeps) {
  let generation = 0;
  let stopped = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let deadlineMs: number | null = null;
  let offsetMs: number | null = null;

  const clear = () => {
    if (timer !== null) {
      deps.clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = (token: number) => {
    if (stopped || token !== generation) return;
    clear();
    if (deadlineMs === null || offsetMs === null) return;
    const now = deps.now() + offsetMs;
    if (!Number.isFinite(now)) return;
    const remaining = deadlineMs - now;
    if (remaining <= 0) {
      // One terminal tick when already overdue; never spin a zero-delay loop.
      deps.onTick();
      return;
    }
    const delay = nextEnrollmentUiDelayMs(remaining);
    if (delay === null || delay <= 0) return;
    timer = deps.setTimeout(() => {
      if (stopped || token !== generation) return;
      deps.onTick();
      // Reschedule only while still counting down; exact-boundary tick is terminal.
      if (stopped || token !== generation || deadlineMs === null || offsetMs === null) return;
      const after = deps.now() + offsetMs;
      if (deadlineMs - after > 0) schedule(token);
    }, delay);
  };

  return {
    start(options: { deadlineMs: number | null; serverTimeOffsetMs: number | null }) {
      generation += 1;
      stopped = false;
      deadlineMs = options.deadlineMs;
      offsetMs = options.serverTimeOffsetMs;
      schedule(generation);
      return generation;
    },
    stop() {
      stopped = true;
      generation += 1;
      clear();
      deadlineMs = null;
      offsetMs = null;
    },
    /** Replace deadline/offset without dropping generation identity mid-flight incorrectly. */
    replace(options: { deadlineMs: number | null; serverTimeOffsetMs: number | null }) {
      generation += 1;
      stopped = false;
      deadlineMs = options.deadlineMs;
      offsetMs = options.serverTimeOffsetMs;
      schedule(generation);
      return generation;
    },
    isRunning() {
      return !stopped;
    },
    currentGeneration() {
      return generation;
    },
  };
}
