import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuthCoordinator } from '../../../client/src/auth/coordinator.ts';
import { accessTokenStore } from '../../../client/src/auth/accessToken.ts';
import type { AuthChannelMessage } from '../../../client/src/auth/types.ts';
import { apiV2 } from '../../../client/src/api/index.ts';
import {
  applyValidatedLoginResponse,
  getAuthCoordinator,
  parseValidatedRefreshResponse,
} from '../../../client/src/auth/sessionRuntime.ts';
import {
  disposeAuthStoreRuntime,
  initAuthStoreRuntime,
  useAuthStore,
} from '../../../client/src/store/useAuthStore.ts';

const token = (iat: number, jti: string) => `e30.${Buffer.from(JSON.stringify({ iat, jti })).toString('base64url')}.sig`;

test('remote ACCESS_UPDATED atomically supersedes an in-flight store bootstrap', async () => {
  const originalAdapter = apiV2.defaults.adapter;
  const originalSetTimeout = globalThis.setTimeout;
  const originalWindow = globalThis.window;
  const originalLocalStorage = globalThis.localStorage;
  let channelListener: ((message: AuthChannelMessage) => void) | null = null;
  let resolveBootstrap!: (response: unknown) => void;
  const bootstrapResponse = new Promise((resolve) => { resolveBootstrap = resolve; });
  const sid = 'a'.repeat(24);
  const initialToken = token(10, 'initial-tab-token');
  const remoteToken = token(11, 'remote-tab-token');
  const staleBootstrapToken = token(12, 'stale-bootstrap-token');
  const user = {
    id: 'member-1',
    name: 'Member One',
    email: 'member@example.test',
    role: 'member' as const,
    level: 'member',
    balance: 0,
    points: 0,
  };

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { pathname: '/', search: '', hash: '' } },
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null, removeItem: () => undefined },
  });
  apiV2.defaults.adapter = (() => bootstrapResponse) as typeof apiV2.defaults.adapter;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void) => ({ callback })) as unknown as typeof setTimeout;

  disposeAuthStoreRuntime();
  accessTokenStore.clear();
  useAuthStore.setState({
    user: null,
    token: null,
    isAuthenticated: false,
    isAdmin: false,
    isOwner: false,
    isTeamMember: false,
    isAuthLoading: false,
    authPhase: 'unauthenticated',
    offlineReturnTo: '/',
    authFailureMessage: null,
    authSessionEpoch: 0,
    serverTimeOffsetMs: null,
  });
  initAuthStoreRuntime({
    channel: {
      post: () => undefined,
      subscribe: (listener) => { channelListener = listener; return () => { channelListener = null; }; },
      close: () => undefined,
    },
  });

  try {
    applyValidatedLoginResponse({
      accessToken: initialToken,
      policy: { sid, roleClass: 'member', accessExpiresAt: '2099-01-01T00:00:00.000Z' },
      user,
    });
    const startEpoch = useAuthStore.getState().authSessionEpoch;
    const bootstrap = useAuthStore.getState().checkAuth();
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(channelListener, 'runtime must subscribe to the real auth channel seam');
    channelListener!({
      type: 'ACCESS_UPDATED',
      accessToken: remoteToken,
      policy: { sid, roleClass: 'member', accessExpiresAt: '2099-01-01T00:00:00.000Z' },
      order: { issuedAt: 11, tokenId: 'remote-tab-token' },
    });

    const replaced = useAuthStore.getState();
    assert.equal(replaced.authSessionEpoch, startEpoch + 1, 'remote replacement must fence stale bootstrap completion');
    assert.equal(replaced.token, remoteToken);
    assert.equal(replaced.user, user);
    assert.equal(replaced.isAuthenticated, true);
    assert.equal(accessTokenStore.get(), remoteToken);
    assert.equal(getAuthCoordinator()?.getSessionSid(), sid);

    resolveBootstrap({
      data: {
        accessToken: staleBootstrapToken,
        session: { sid, roleClass: 'member', accessExpiresAt: '2099-01-01T00:00:00.000Z' },
        user,
      },
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {},
    });
    await bootstrap;

    const settled = useAuthStore.getState();
    assert.equal(settled.authSessionEpoch, startEpoch + 1);
    assert.equal(settled.token, remoteToken);
    assert.equal(settled.user, user);
    assert.equal(settled.isAuthenticated, true);
    assert.equal(accessTokenStore.get(), remoteToken);
    assert.equal(getAuthCoordinator()?.getSessionSid(), sid);
  } finally {
    disposeAuthStoreRuntime();
    accessTokenStore.clear();
    apiV2.defaults.adapter = originalAdapter;
    globalThis.setTimeout = originalSetTimeout;
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalLocalStorage });
  }
});

test('a disposed bootstrap cannot overwrite a newer runtime loading state', async () => {
  const originalAdapter = apiV2.defaults.adapter;
  const originalWindow = globalThis.window;
  const originalLocalStorage = globalThis.localStorage;
  let resolvePending!: (response: unknown) => void;
  const pending = new Promise((resolve) => { resolvePending = resolve; });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { pathname: '/', search: '', hash: '' } },
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null, removeItem: () => undefined },
  });
  apiV2.defaults.adapter = (() => pending) as typeof apiV2.defaults.adapter;

  const resetStore = () => {
    disposeAuthStoreRuntime();
    accessTokenStore.clear();
    useAuthStore.setState({
      user: null,
      token: null,
      isAuthenticated: false,
      isAdmin: false,
      isOwner: false,
      isTeamMember: false,
      isAuthLoading: false,
      authPhase: 'unauthenticated',
      offlineReturnTo: '/',
      authFailureMessage: null,
      authSessionEpoch: 0,
      serverTimeOffsetMs: null,
    });
  };

  let activeChannelListener: ((message: AuthChannelMessage) => void) | null = null;
  const channel = {
    post: () => undefined,
    subscribe: (listener: (message: AuthChannelMessage) => void) => {
      activeChannelListener = listener;
      return () => { activeChannelListener = null; };
    },
    close: () => undefined,
  };

  resetStore();
  initAuthStoreRuntime({ channel });
  const abandonedBootstrap = useAuthStore.getState().checkAuth();
  await new Promise((resolve) => setImmediate(resolve));

  // React StrictMode can dispose the first effect and immediately create a new runtime.
  // The abandoned request must not write an offline/error phase after that replacement starts.
  disposeAuthStoreRuntime();
  initAuthStoreRuntime({ channel });
  const currentBootstrap = useAuthStore.getState().checkAuth();
  await new Promise((resolve) => setImmediate(resolve));
  await abandonedBootstrap;

  const stateAfterAbandonedRequest = useAuthStore.getState();
  assert.equal(stateAfterAbandonedRequest.isAuthLoading, true);
  assert.notEqual(stateAfterAbandonedRequest.authPhase, 'offline-stale');
  assert.notEqual(stateAfterAbandonedRequest.authPhase, 'bootstrap-retry');
  assert.equal(typeof activeChannelListener, 'function');

  disposeAuthStoreRuntime();
  resolvePending({ data: {}, status: 499, statusText: 'abandoned', headers: {}, config: {} });
  await currentBootstrap;
  apiV2.defaults.adapter = originalAdapter;
  accessTokenStore.clear();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalLocalStorage });
});

test('real refresh envelopes derive role class only from exact authoritative user roles', () => {
  for (const [role, expected] of [['member', 'member'], ['owner', 'staff'], ['admin', 'staff'], ['cs', 'staff']] as const) {
    const parsed = parseValidatedRefreshResponse({
      accessToken: token(20, `refresh-${role}`),
      user: { id: `${role}-1`, name: role, email: `${role}@example.test`, role },
      session: {
        sid: 'a'.repeat(24),
        accessExpiresAt: '2099-01-01T00:00:00.000Z',
        roleClass: expected === 'staff' ? 'member' : 'staff',
        role: expected === 'staff' ? 'member' : 'admin',
      },
    });
    assert.equal(parsed.policy.roleClass, expected, role);
  }
});

test('real refresh envelopes reject absent or unrecognized authoritative user roles', () => {
  const invalidUsers: Array<[string, unknown]> = [
    ['missing user', undefined],
    ['null user', null],
    ['missing role', { id: 'missing-role' }],
    ['empty role', { id: 'empty-role', role: '' }],
    ['unknown role', { id: 'unknown-role', role: 'superadmin' }],
    ['literal staff role', { id: 'staff-role', role: 'staff' }],
  ];

  for (const [label, user] of invalidUsers) {
    for (const hostileSession of [
      { roleClass: 'staff', role: 'admin' },
      { roleClass: 'member', role: 'member' },
    ]) {
      assert.throws(() => parseValidatedRefreshResponse({
        accessToken: token(21, `invalid-${label.replaceAll(' ', '-')}`),
        ...(label === 'missing user' ? {} : { user }),
        session: {
          sid: 'b'.repeat(24),
          accessExpiresAt: '2099-01-01T00:00:00.000Z',
          ...hostileSession,
        },
      }), /role|user/i, `${label} must not inherit ${hostileSession.roleClass}/${hostileSession.role}`);
    }
  }
});

test('real refresh role authority never falls back to JWT claims', () => {
  const jwtWithStaffHints = `e30.${Buffer.from(JSON.stringify({
    iat: 22,
    jti: 'jwt-role-hints',
    role: 'admin',
    roleClass: 'staff',
    sid: 'c'.repeat(24),
    exp: 4_070_908_800,
  })).toString('base64url')}.sig`;

  assert.throws(() => parseValidatedRefreshResponse({
    accessToken: jwtWithStaffHints,
    user: { id: 'unknown-role', role: 'unknown' },
    session: {},
  }), /role|user/i);
});

test('cross-audience ACCESS_UPDATED is rejected before any credential plane commits', () => {
  for (const scenario of [
    { localRole: 'member' as const, localClass: 'member' as const, remoteRole: 'admin' as const, remoteClass: 'staff' as const },
    { localRole: 'admin' as const, localClass: 'staff' as const, remoteRole: 'member' as const, remoteClass: 'member' as const },
  ]) {
    const originalSetTimeout = globalThis.setTimeout;
    let listener: ((message: AuthChannelMessage) => void) | null = null;
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void) => ({ callback })) as unknown as typeof setTimeout;
    disposeAuthStoreRuntime();
    accessTokenStore.clear();
    useAuthStore.setState({
      user: null, token: null, isAuthenticated: false, isAdmin: false, isOwner: false,
      isTeamMember: false, isAuthLoading: false, authPhase: 'unauthenticated', offlineReturnTo: '/',
      authFailureMessage: null, authSessionEpoch: 0, serverTimeOffsetMs: null,
    });
    initAuthStoreRuntime({ channel: {
      post: () => undefined,
      subscribe: (next) => { listener = next; return () => { listener = null; }; },
      close: () => undefined,
    } });
    try {
      const sid = 'b'.repeat(24);
      const localToken = token(30, `local-${scenario.localRole}`);
      const localUser = {
        id: `local-${scenario.localRole}`, name: 'Local', email: 'local@example.test',
        role: scenario.localRole, level: 'member', balance: 0, points: 0,
      };
      applyValidatedLoginResponse({
        accessToken: localToken,
        policy: { sid, roleClass: scenario.localClass, accessExpiresAt: '2099-01-01T00:00:00.000Z' },
        user: localUser,
      });
      const before = useAuthStore.getState();
      const rejectedToken = token(32, `remote-${scenario.remoteRole}`);
      const rejected = parseValidatedRefreshResponse({
        accessToken: rejectedToken,
        user: { id: `remote-${scenario.remoteRole}`, name: 'Remote', email: 'remote@example.test', role: scenario.remoteRole },
        session: { sid, accessExpiresAt: '2099-01-01T00:00:00.000Z' },
      });
      listener!({ type: 'ACCESS_UPDATED', accessToken: rejected.accessToken, policy: rejected.policy, order: { issuedAt: 32, tokenId: `remote-${scenario.remoteRole}` } });

      assert.equal(accessTokenStore.get(), localToken, 'rejected audience must not mutate token store');
      assert.equal(getAuthCoordinator()?.getSessionSid(), sid);
      assert.equal(useAuthStore.getState().token, localToken);
      assert.equal(useAuthStore.getState().user, localUser);
      assert.equal(useAuthStore.getState().authSessionEpoch, before.authSessionEpoch);

      // Proves rejected order was not committed: a lower but still newer valid rotation must win.
      const validToken = token(31, `valid-${scenario.localRole}`);
      listener!({
        type: 'ACCESS_UPDATED', accessToken: validToken,
        policy: { sid, roleClass: scenario.localClass, accessExpiresAt: '2099-01-01T00:00:00.000Z' },
        order: { issuedAt: 31, tokenId: `valid-${scenario.localRole}` },
      });
      assert.equal(accessTokenStore.get(), validToken);
      assert.equal(useAuthStore.getState().token, validToken);
      assert.equal(useAuthStore.getState().user, localUser);
      assert.equal(useAuthStore.getState().authSessionEpoch, before.authSessionEpoch + 1);
    } finally {
      disposeAuthStoreRuntime();
      accessTokenStore.clear();
      globalThis.setTimeout = originalSetTimeout;
    }
  }
});

test('terminal and logout transitions fence late in-flight store bootstrap completion', async () => {
  for (const ending of ['terminal', 'logout'] as const) {
    const originalAdapter = apiV2.defaults.adapter;
    const originalSetTimeout = globalThis.setTimeout;
    const originalWindow = globalThis.window;
    const originalLocalStorage = globalThis.localStorage;
    let listener: ((message: AuthChannelMessage) => void) | null = null;
    let resolveBootstrap!: (response: unknown) => void;
    const pendingBootstrap = new Promise((resolve) => { resolveBootstrap = resolve; });
    const sid = 'c'.repeat(24);
    const user = { id: 'member-terminal', name: 'Member', email: 'member@example.test', role: 'member' as const, level: 'member', balance: 0, points: 0 };
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { pathname: '/dashboard', search: '', hash: '', href: '' } } });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, removeItem: () => undefined } });
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void) => ({ callback })) as unknown as typeof setTimeout;
    apiV2.defaults.adapter = (async (config) => {
      if (config.url === '/auth/logout') return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
      return pendingBootstrap as never;
    }) as typeof apiV2.defaults.adapter;
    disposeAuthStoreRuntime(); accessTokenStore.clear();
    useAuthStore.setState({ user: null, token: null, isAuthenticated: false, isAdmin: false, isOwner: false, isTeamMember: false, isAuthLoading: false, authPhase: 'unauthenticated', offlineReturnTo: '/', authFailureMessage: null, authSessionEpoch: 0, serverTimeOffsetMs: null });
    initAuthStoreRuntime({ channel: { post: () => undefined, subscribe: (next) => { listener = next; return () => { listener = null; }; }, close: () => undefined } });
    try {
      const initialToken = token(40, ending);
      applyValidatedLoginResponse({ accessToken: initialToken, policy: { sid, roleClass: 'member', accessExpiresAt: '2099-01-01T00:00:00.000Z' }, user });
      const startEpoch = useAuthStore.getState().authSessionEpoch;
      const bootstrap = useAuthStore.getState().checkAuth();
      await new Promise((resolve) => setImmediate(resolve));
      if (ending === 'terminal') listener!({ type: 'SESSION_REVOKED', reason: 'targeted', sid });
      else await useAuthStore.getState().logout();
      assert.equal(useAuthStore.getState().authSessionEpoch, startEpoch + 1, `${ending} must fence bootstrap immediately`);

      resolveBootstrap({ data: { accessToken: token(41, 'late'), user, session: { sid, accessExpiresAt: '2099-01-01T00:00:00.000Z' } }, status: 200, statusText: 'OK', headers: {}, config: {} });
      await bootstrap;
      const final = useAuthStore.getState();
      assert.equal(final.authPhase, ending === 'terminal' ? 'revoked' : 'unauthenticated');
      assert.equal(final.token, null);
      assert.equal(final.user, null);
      assert.equal(final.isAuthenticated, false);
      assert.equal(final.authSessionEpoch, startEpoch + 1);
      assert.equal(accessTokenStore.get(), null);
      assert.equal(getAuthCoordinator()?.getSessionSid(), null);
    } finally {
      disposeAuthStoreRuntime(); accessTokenStore.clear(); apiV2.defaults.adapter = originalAdapter; globalThis.setTimeout = originalSetTimeout;
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalLocalStorage });
    }
  }
});

test('local login supersedes an older anonymous bootstrap failure', async () => {
  let rejectBootstrap!: (error: unknown) => void;
  const bootstrapResponse = new Promise<never>((_, reject) => { rejectBootstrap = reject; });
  const phases: string[] = [];
  const terminal: string[] = [];
  let memoryToken: string | null = null;
  const coordinator = createAuthCoordinator({
    refresh: () => bootstrapResponse,
    migrate: async () => { throw new Error('not used'); },
    tokenStore: { get: () => memoryToken, set: (value) => { memoryToken = value; }, clear: () => { memoryToken = null; } },
    channel: { post: () => undefined, subscribe: () => () => undefined, close: () => undefined },
    setPhase: (phase) => phases.push(phase),
    onAuthenticated: () => undefined,
    onTerminal: (code) => terminal.push(code),
    delay: async () => undefined,
    now: () => 0,
    legacyStorage: { readOnce: () => null, remove: () => undefined },
    scheduleTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
  });
  const bootstrap = coordinator.bootstrapSession();
  const loginToken = token(2, 'login');
  coordinator.installLocalCredential({ accessToken: loginToken, policy: { sid: 'a'.repeat(24), roleClass: 'staff', accessExpiresAt: '2099-01-01T00:00:00.000Z' } });
  rejectBootstrap({ response: { status: 401, data: { error: { code: 'AUTH_TOKEN_INVALID' } } } });
  await assert.rejects(bootstrap);
  assert.equal(memoryToken, loginToken);
  assert.equal(phases.at(-1), 'authenticated');
  assert.deepEqual(terminal, []);
  coordinator.dispose();
});

test('logout supersedes an older refresh success', async () => {
  let resolveRefresh!: (result: { accessToken: string; policy: { sid: string; roleClass: 'staff'; accessExpiresAt: string } }) => void;
  const response = new Promise<{ accessToken: string; policy: { sid: string; roleClass: 'staff'; accessExpiresAt: string } }>((resolve) => { resolveRefresh = resolve; });
  let memoryToken: string | null = null;
  const coordinator = createAuthCoordinator({
    refresh: () => response, migrate: async () => { throw new Error('not used'); },
    tokenStore: { get: () => memoryToken, set: (value) => { memoryToken = value; }, clear: () => { memoryToken = null; } },
    channel: { post: () => undefined, subscribe: () => () => undefined, close: () => undefined },
    setPhase: () => undefined, onAuthenticated: () => undefined, onTerminal: () => undefined,
    delay: async () => undefined, now: () => 0,
    scheduleTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
  });
  coordinator.installLocalCredential({ accessToken: token(1, 'initial'), policy: { sid: 'a'.repeat(24), roleClass: 'staff', accessExpiresAt: '2099-01-01T00:00:00.000Z' } });
  const refresh = coordinator.refreshOnce('test');
  coordinator.clearSession('user-logout');
  resolveRefresh({ accessToken: token(2, 'late'), policy: { sid: 'a'.repeat(24), roleClass: 'staff', accessExpiresAt: '2099-01-01T00:00:00.000Z' } });
  await assert.rejects(refresh, { name: 'CoordinatorOperationSupersededError' });
  assert.equal(memoryToken, null);
  coordinator.dispose();
});

test('remote revocation supersedes an older refresh success', async () => {
  let resolveRefresh!: (result: { accessToken: string; policy: { sid: string; roleClass: 'staff'; accessExpiresAt: string } }) => void;
  const response = new Promise<{ accessToken: string; policy: { sid: string; roleClass: 'staff'; accessExpiresAt: string } }>((resolve) => { resolveRefresh = resolve; });
  let memoryToken: string | null = null;
  const phases: string[] = [];
  const coordinator = createAuthCoordinator({
    refresh: () => response, migrate: async () => { throw new Error('not used'); },
    tokenStore: { get: () => memoryToken, set: (value) => { memoryToken = value; }, clear: () => { memoryToken = null; } },
    channel: { post: () => undefined, subscribe: () => () => undefined, close: () => undefined },
    setPhase: (phase) => phases.push(phase), onAuthenticated: () => undefined, onTerminal: () => undefined,
    delay: async () => undefined, now: () => 0,
    scheduleTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
  });
  const sid = 'a'.repeat(24);
  coordinator.installLocalCredential({ accessToken: token(1, 'initial'), policy: { sid, roleClass: 'staff', accessExpiresAt: '2099-01-01T00:00:00.000Z' } });
  const refresh = coordinator.refreshOnce('test');
  coordinator.acceptChannelMessage({ type: 'SESSION_REVOKED', reason: 'targeted', sid });
  resolveRefresh({ accessToken: token(2, 'late'), policy: { sid, roleClass: 'staff', accessExpiresAt: '2099-01-01T00:00:00.000Z' } });
  await assert.rejects(refresh, { name: 'CoordinatorOperationSupersededError' });
  assert.equal(memoryToken, null);
  assert.equal(phases.at(-1), 'revoked');
  coordinator.dispose();
});

test('local login supersedes a deferred legacy migration', async () => {
  let rejectRefresh!: (error: unknown) => void;
  let resolveMigration!: (result: { accessToken: string; policy: { sid: string; roleClass: 'staff'; accessExpiresAt: string } }) => void;
  const refreshResponse = new Promise<never>((_, reject) => { rejectRefresh = reject; });
  const migrationResponse = new Promise<{ accessToken: string; policy: { sid: string; roleClass: 'staff'; accessExpiresAt: string } }>((resolve) => { resolveMigration = resolve; });
  let memoryToken: string | null = null;
  const coordinator = createAuthCoordinator({
    refresh: () => refreshResponse, migrate: () => migrationResponse,
    tokenStore: { get: () => memoryToken, set: (value) => { memoryToken = value; }, clear: () => { memoryToken = null; } },
    channel: { post: () => undefined, subscribe: () => () => undefined, close: () => undefined },
    setPhase: () => undefined, onAuthenticated: () => undefined, onTerminal: () => undefined,
    delay: async () => undefined, now: () => 0,
    legacyStorage: { readOnce: () => 'legacy', remove: () => undefined },
    scheduleTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
  });
  const bootstrap = coordinator.bootstrapSession();
  rejectRefresh({ response: { status: 401, data: { error: { code: 'AUTH_TOKEN_INVALID' } } } });
  await new Promise((resolve) => setImmediate(resolve));
  const loginToken = token(3, 'login');
  coordinator.installLocalCredential({ accessToken: loginToken, policy: { sid: 'a'.repeat(24), roleClass: 'staff', accessExpiresAt: '2099-01-01T00:00:00.000Z' } });
  resolveMigration({ accessToken: token(2, 'migration'), policy: { sid: 'b'.repeat(24), roleClass: 'staff', accessExpiresAt: '2099-01-01T00:00:00.000Z' } });
  await assert.rejects(bootstrap, { name: 'CoordinatorOperationSupersededError' });
  assert.equal(memoryToken, loginToken);
  coordinator.dispose();
});

test('local login supersedes an older anonymous bootstrap success', async () => {
  let resolveBootstrap!: (result: { accessToken: string; policy: { sid: string; roleClass: 'staff'; accessExpiresAt: string } }) => void;
  const bootstrapResponse = new Promise<{ accessToken: string; policy: { sid: string; roleClass: 'staff'; accessExpiresAt: string } }>((resolve) => { resolveBootstrap = resolve; });
  let memoryToken: string | null = null;
  const coordinator = createAuthCoordinator({
    refresh: () => bootstrapResponse,
    migrate: async () => { throw new Error('not used'); },
    tokenStore: { get: () => memoryToken, set: (value) => { memoryToken = value; }, clear: () => { memoryToken = null; } },
    channel: { post: () => undefined, subscribe: () => () => undefined, close: () => undefined },
    setPhase: () => undefined,
    onAuthenticated: () => undefined,
    onTerminal: () => undefined,
    delay: async () => undefined,
    now: () => 0,
    legacyStorage: { readOnce: () => null, remove: () => undefined },
    scheduleTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
  });
  const bootstrap = coordinator.bootstrapSession();
  const loginToken = token(2, 'login');
  coordinator.installLocalCredential({ accessToken: loginToken, policy: { sid: 'a'.repeat(24), roleClass: 'staff', accessExpiresAt: '2099-01-01T00:00:00.000Z' } });
  resolveBootstrap({ accessToken: token(1, 'bootstrap'), policy: { sid: 'b'.repeat(24), roleClass: 'staff', accessExpiresAt: '2099-01-01T00:00:00.000Z' } });
  await assert.rejects(bootstrap, { name: 'CoordinatorOperationSupersededError' });
  assert.equal(memoryToken, loginToken);
  assert.equal(coordinator.getSessionSid(), 'a'.repeat(24));
  coordinator.dispose();
});
