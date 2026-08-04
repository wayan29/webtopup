import type { AuthChannel } from './channel.ts';

export type IdlePhase = 'active' | 'warning' | 'locked';
export type IdleState = { phase: IdlePhase; warningAt?: number; idleExpiresAt?: number };
export type ActivityReply = { warningAt: number | string; idleExpiresAt: number | string };
type EventSource = {
  addEventListener(type: string, listener: (event: { isTrusted?: boolean }) => void): void;
  removeEventListener(type: string, listener: (event: { isTrusted?: boolean }) => void): void;
};
type Timer = ReturnType<typeof setTimeout>;

export type StaffActivityDependencies = {
  now(): number;
  events: EventSource;
  getStatus(): Promise<ActivityReply>;
  postActivity(): Promise<ActivityReply>;
  onState(state: IdleState): void;
  setTimeout(fn: () => void, ms: number): Timer;
  clearTimeout(timer: Timer): void;
  channel?: AuthChannel;
  sid?: string;
};

const HEARTBEAT_MS = 60_000;
const toMillis = (value: number | string) => (typeof value === 'number' ? value : Date.parse(value));

function idleLockedFromError(error: unknown): boolean {
  const code = (error as { response?: { data?: { error?: { code?: string }; code?: string } } })?.response?.data;
  return code?.error?.code === 'AUTH_IDLE_LOCKED' || code?.code === 'AUTH_IDLE_LOCKED';
}

export function createStaffActivityController(deps: StaffActivityDependencies) {
  let lastHeartbeat = -HEARTBEAT_MS;
  let stopped = true;
  let generation = 0;
  let warningTimer: Timer | null = null;
  let lockTimer: Timer | null = null;
  let unsubscribe: (() => void) | null = null;
  let lockBroadcasted = false;
  let lastDeadlines: Pick<IdleState, 'warningAt' | 'idleExpiresAt'> | null = null;

  const isCurrent = (token: number, sid = deps.sid) => !stopped && token === generation && sid === deps.sid;

  const cancelTimers = () => {
    if (warningTimer !== null) deps.clearTimeout(warningTimer);
    if (lockTimer !== null) deps.clearTimeout(lockTimer);
    warningTimer = lockTimer = null;
  };

  const lock = (
    broadcast = true,
    token = generation,
    state?: Pick<IdleState, 'warningAt' | 'idleExpiresAt'>,
  ) => {
    if (!isCurrent(token)) return;
    cancelTimers();
    const deadlines = state ?? lastDeadlines;
    deps.onState(deadlines ? { phase: 'locked', ...deadlines } : { phase: 'locked' });
    if (broadcast && deps.sid && !lockBroadcasted) {
      lockBroadcasted = true;
      deps.channel?.post({ type: 'LOCKED', reason: 'idle', sid: deps.sid });
    }
  };

  const schedule = (raw: ActivityReply, token = generation) => {
    if (!isCurrent(token)) return;
    const warningAt = toMillis(raw.warningAt);
    const idleExpiresAt = toMillis(raw.idleExpiresAt);
    if (!Number.isFinite(warningAt) || !Number.isFinite(idleExpiresAt)) return;
    cancelTimers();
    const now = deps.now();
    lastDeadlines = { warningAt, idleExpiresAt };
    if (now >= idleExpiresAt) {
      lock(true, token, { warningAt, idleExpiresAt });
      return;
    }
    deps.onState({
      phase: now >= warningAt ? 'warning' : 'active',
      warningAt,
      idleExpiresAt,
    });
    if (now < warningAt) {
      warningTimer = deps.setTimeout(() => {
        if (isCurrent(token)) deps.onState({ phase: 'warning', warningAt, idleExpiresAt });
      }, warningAt - now);
    }
    if (now < idleExpiresAt) {
      lockTimer = deps.setTimeout(() => lock(true, token), idleExpiresAt - now);
    }
  };

  const onActivity = (event: { isTrusted?: boolean }) => {
    if (event.isTrusted !== true || stopped || deps.now() - lastHeartbeat < HEARTBEAT_MS) return;
    lastHeartbeat = deps.now();
    const token = generation;
    void deps
      .postActivity()
      .then((reply) => schedule(reply, token))
      .catch((error: unknown) => {
        if (!isCurrent(token)) return;
        if (idleLockedFromError(error)) lock(false, token);
      });
  };

  const handleStatusResult = (reply: ActivityReply, token: number) => {
    if (!isCurrent(token)) return;
    schedule(reply, token);
  };

  const handleStatusError = (error: unknown, token: number) => {
    if (!isCurrent(token)) return;
    if (idleLockedFromError(error)) lock(false, token);
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      generation++;
      lockBroadcasted = false;
      const token = generation;
      const sidAtStart = deps.sid;
      for (const type of ['pointerdown', 'keydown', 'touchstart']) deps.events.addEventListener(type, onActivity);
      void deps
        .getStatus()
        .then((reply) => {
          if (!isCurrent(token, sidAtStart)) return;
          handleStatusResult(reply, token);
        })
        .catch((error) => {
          if (!isCurrent(token, sidAtStart)) return;
          handleStatusError(error, token);
        });
      unsubscribe =
        deps.channel?.subscribe((message) => {
          if (message.type === 'LOCKED' && message.sid === deps.sid) lock(false);
        }) ?? null;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      generation++;
      cancelTimers();
      for (const type of ['pointerdown', 'keydown', 'touchstart']) deps.events.removeEventListener(type, onActivity);
      unsubscribe?.();
      unsubscribe = null;
    },
    lock,
    schedule,
  };
}

export function shouldStartStaffActivity(role: string | undefined, phase: string): boolean {
  return phase === 'authenticated' && role !== undefined && ['owner', 'admin', 'cs'].includes(role);
}

export function createBrowserStaffActivityController(options: {
  getStatus(): Promise<ActivityReply>;
  postActivity(): Promise<ActivityReply>;
  onState(state: IdleState): void;
  channel?: AuthChannel;
  sid?: string;
}) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  return createStaffActivityController({
    now: () => Date.now(),
    events: document,
    getStatus: options.getStatus,
    postActivity: options.postActivity,
    onState: options.onState,
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (id) => window.clearTimeout(id),
    channel: options.channel,
    sid: options.sid,
  });
}