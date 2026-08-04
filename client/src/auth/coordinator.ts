import type { AccessTokenStore } from './accessToken.ts';
import type { AuthChannel } from './channel.ts';
import type { AccessOrder, AuthChannelMessage, AuthPhase, RefreshResponse, RetryableRequest } from './types.ts';

type AuthCode = string | undefined;
type LegacyStorage = { readOnce(): string | null; remove(): void };
export class CoordinatorDisposedError extends Error { constructor() { super('Auth coordinator disposed'); this.name = 'CoordinatorDisposedError'; } }
export class CoordinatorOperationSupersededError extends Error { constructor() { super('Auth coordinator operation superseded'); this.name = 'CoordinatorOperationSupersededError'; } }

export type CoordinatorDependencies = {
    refresh(): Promise<RefreshResponse>; migrate(legacyToken: string): Promise<RefreshResponse>;
    tokenStore: AccessTokenStore; channel: AuthChannel; setPhase(phase: AuthPhase): void;
    acceptRemote?(result: RefreshResponse): boolean;
    onAuthenticated(result: RefreshResponse, source: 'local' | 'remote'): void; onTerminal(code: string): void;
    delay(ms: number): Promise<void>; now(): number; legacyStorage?: LegacyStorage;
    recoveryBackoffsMs?: readonly number[]; raceWaitMs?: number;
    scheduleTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
};
const TERMINAL_CODES = new Set(['AUTH_REFRESH_RECOVERY_EXPIRED','AUTH_SESSION_EXPIRED','AUTH_SESSION_REVOKED','AUTH_SESSION_POLICY_CHANGED','AUTH_REFRESH_REUSED','AUTH_ACCOUNT_DISABLED','AUTH_TOKEN_INVALID']);
const TEMPORARY_STATUSES = new Set([500, 502, 503]);
function errorInfo(error: unknown): { code: AuthCode; status?: number } {
    const response = (error as { response?: { status?: number; data?: { error?: { code?: string } } } })?.response;
    return { code: response?.data?.error?.code, status: response?.status };
}
function headerValue(headers: Record<string, unknown> | undefined, name: string): string | undefined {
    const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
    return typeof entry?.[1] === 'string' ? entry[1] : undefined;
}
export function isReplayEligible(config: RetryableRequest): boolean {
    const method = (config.method ?? 'get').toLowerCase();
    return ['get','head','options'].includes(method) || config.authRetrySafe === true || Boolean(headerValue(config.headers, 'Idempotency-Key')?.trim());
}
function tokenOrder(token: string): AccessOrder | null {
    try {
        const segment = token.split('.')[1]; if (!segment) return null;
        const payload = JSON.parse(atob(segment.replace(/-/g, '+').replace(/_/g, '/'))) as { iat?: unknown; jti?: unknown };
        if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)) return null;
        return { issuedAt: payload.iat, tokenId: typeof payload.jti === 'string' ? payload.jti : token };
    } catch { return null; }
}
function compareOrder(a: AccessOrder, b: AccessOrder): number { return a.issuedAt - b.issuedAt || a.tokenId.localeCompare(b.tokenId); }

export function createAuthCoordinator(deps: CoordinatorDependencies) {
    let inFlight: Promise<RefreshResponse> | null = null, terminalTransitioned = false, legacyRead = false, disposed = false;
    let proactiveTimer: ReturnType<typeof setTimeout> | null = null, channelUnsubscribe: (() => void) | null = null;
    let currentSid: string | null = null, currentOrder: AccessOrder | null = null, acceptsRemoteAccess = false, credentialGeneration = 0;
    const waiters = new Set<{ reject(error: Error): void }>();
    let signalDisposed!: () => void;
    const disposedSignal = new Promise<void>((resolve) => { signalDisposed = resolve; });
    const recoveryBackoffs = deps.recoveryBackoffsMs ?? [250,750,1500], raceWaitMs = deps.raceWaitMs ?? 1500;
    const scheduleTimer = deps.scheduleTimer ?? ((fn, ms) => setTimeout(fn, ms));
    const accessListeners = new Set<(message: Extract<AuthChannelMessage,{type:'ACCESS_UPDATED'}>) => void>();
    const ensureActive = () => { if (disposed) throw new CoordinatorDisposedError(); };
    const untilDisposed = <T>(operation: Promise<T>): Promise<T> => Promise.race([
        operation,
        disposedSignal.then(() => { throw new CoordinatorDisposedError(); }),
    ]);
    function cancelProactive() { if (proactiveTimer) clearTimeout(proactiveTimer); proactiveTimer = null; }
    function transitionTerminal(code: string) {
        cancelProactive(); credentialGeneration++; deps.tokenStore.clear(); acceptsRemoteAccess = false; currentSid = null; currentOrder = null;
        if (!terminalTransitioned) { terminalTransitioned = true; deps.setPhase('revoked'); deps.onTerminal(code); }
    }
    function scheduleProactive(result: RefreshResponse) {
        cancelProactive(); const expiresAt = Date.parse(result.policy.accessExpiresAt); if (!Number.isFinite(expiresAt)) return;
        proactiveTimer = scheduleTimer(() => { if (!disposed) void refreshOnce('proactive').catch(() => undefined); }, Math.max(0, expiresAt - deps.now() - 30_000));
    }
    function install(result: RefreshResponse, broadcast: boolean, deliberate: boolean): RefreshResponse {
        ensureActive(); const order = tokenOrder(result.accessToken); if (!order) throw new Error('Access token lacks trusted issue ordering');
        if (!deliberate && (
            !acceptsRemoteAccess
            || result.policy.sid !== currentSid
            || (currentOrder && compareOrder(order, currentOrder) <= 0)
            || !(deps.acceptRemote?.(result) ?? true)
        )) return result;
        terminalTransitioned = false; acceptsRemoteAccess = true; currentSid = result.policy.sid; currentOrder = order; credentialGeneration++;
        deps.tokenStore.set(result.accessToken); deps.setPhase('authenticated'); deps.onAuthenticated(result, broadcast ? 'local' : 'remote'); scheduleProactive(result);
        if (broadcast) deps.channel.post({ type:'ACCESS_UPDATED', accessToken:result.accessToken, policy:result.policy, order });
        return result;
    }
    function installLocalCredential(result: RefreshResponse) { return install(result, true, true); }
    function waitForWinner(): Promise<void> {
        ensureActive(); return new Promise((resolve, reject) => {
            let settled = false; let timer: ReturnType<typeof setTimeout>;
            const waiter = { reject: (error: Error) => finish(error) };
            const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); accessListeners.delete(listener); waiters.delete(waiter); error ? reject(error) : resolve(); };
            const listener = () => finish(); accessListeners.add(listener); waiters.add(waiter); timer = scheduleTimer(() => finish(), raceWaitMs);
        });
    }
    async function classifyAttempt(allowRace: boolean, options: { deferTerminalInvalid?: boolean; expectedGeneration: number }): Promise<RefreshResponse> {
        for (let recoveryAttempt = 0; ; recoveryAttempt++) {
            ensureActive();
            try {
                const result = await untilDisposed(deps.refresh());
                if (credentialGeneration !== options.expectedGeneration) throw new CoordinatorOperationSupersededError();
                return install(result, true, true);
            }
            catch (error) {
                if (error instanceof CoordinatorDisposedError || error instanceof CoordinatorOperationSupersededError) throw error;
                if (credentialGeneration !== options.expectedGeneration) throw new CoordinatorOperationSupersededError();
                const { code, status } = errorInfo(error);
                if (code === 'AUTH_REFRESH_RACE' && allowRace) { await waitForWinner(); return classifyAttempt(false, options); }
                if (code === 'AUTH_REFRESH_RECOVERY_UNAVAILABLE' && recoveryAttempt < recoveryBackoffs.length) { deps.setPhase('offline-stale'); await untilDisposed(deps.delay(recoveryBackoffs[recoveryAttempt]!)); continue; }
                if (code && TERMINAL_CODES.has(code)) { if (!(options?.deferTerminalInvalid && code === 'AUTH_TOKEN_INVALID')) transitionTerminal(code); }
                else if (code === 'AUTH_REFRESH_RACE' || status === undefined || TEMPORARY_STATUSES.has(status)) deps.setPhase('offline-stale');
                throw error;
            }
        }
    }
    async function performRefresh(options?: { deferTerminalInvalid?: boolean }) { ensureActive(); deps.setPhase('refreshing'); return classifyAttempt(true, { ...options, expectedGeneration: credentialGeneration }); }
    function refreshOnce(_reason: string): Promise<RefreshResponse> { ensureActive(); if (!inFlight) inFlight = performRefresh().finally(() => { inFlight = null; }); return inFlight; }
    async function bootstrapSession() {
        ensureActive(); deps.setPhase('initializing');
        try { const result = await performRefresh({deferTerminalInvalid:true}); deps.legacyStorage?.remove(); return result; }
        catch (refreshError) {
            if (refreshError instanceof CoordinatorOperationSupersededError) throw refreshError;
            const {code}=errorInfo(refreshError);
            if (!legacyRead && code==='AUTH_TOKEN_INVALID' && deps.legacyStorage) { legacyRead=true; const legacy=deps.legacyStorage.readOnce(); if (legacy) { const migrationGeneration=credentialGeneration; try { const result=await untilDisposed(deps.migrate(legacy)); if(credentialGeneration!==migrationGeneration) throw new CoordinatorOperationSupersededError(); return install(result,true,true); } finally { deps.legacyStorage.remove(); } } transitionTerminal('AUTH_TOKEN_INVALID'); }
            throw refreshError;
        }
    }
    async function handleAuthFailure<T>(config: RetryableRequest,retry:(config:RetryableRequest)=>Promise<T>,error:unknown):Promise<T>{
        const {code}=errorInfo(error); if(code!=='AUTH_ACCESS_EXPIRED'||config._authRetried||config.url?.includes('/auth/refresh')||!isReplayEligible(config)) throw error;
        const result=await refreshOnce('reactive'); return retry({...config,_authRetried:true,headers:{...config.headers,Authorization:`Bearer ${result.accessToken}`}});
    }
    function clearSession(reason:string,broadcast=true){ const sid=currentSid; cancelProactive(); credentialGeneration++; deps.tokenStore.clear(); acceptsRemoteAccess=false; currentSid=null; currentOrder=null; terminalTransitioned=true; deps.setPhase('unauthenticated'); if(broadcast) deps.channel.post({type:'LOGGED_OUT',reason,sid:sid ?? undefined}); }
    function lockSession(broadcast=true){ if(disposed||!currentSid)return; cancelProactive(); deps.setPhase('locked'); if(broadcast)deps.channel.post({type:'LOCKED',reason:'idle',sid:currentSid}); }
    function acceptChannelMessage(message:AuthChannelMessage){
        if(disposed) return;
        if(message.type==='ACCESS_UPDATED'){ const derived=tokenOrder(message.accessToken); if(derived && compareOrder(derived,message.order)===0) { const before=deps.tokenStore.get(); install({accessToken:message.accessToken,policy:message.policy},false,false); if(deps.tokenStore.get()!==before) accessListeners.forEach(l=>l(message)); } }
        else if(message.type==='LOGGED_OUT'){ if(!message.sid||message.sid===currentSid) clearSession(message.reason,false); }
        else if(message.type==='SESSION_REVOKED'){ if(!message.sid||message.sid===currentSid) transitionTerminal(message.reason); }
        else if(message.type==='LOCKED'){ if(message.sid===currentSid) lockSession(false); } else void refreshOnce('cross-tab').catch(()=>undefined);
    }
    channelUnsubscribe=deps.channel.subscribe(acceptChannelMessage);
    function dispose(){ if(disposed)return; disposed=true; signalDisposed(); cancelProactive(); for(const waiter of [...waiters]) waiter.reject(new CoordinatorDisposedError()); accessListeners.clear(); channelUnsubscribe?.(); channelUnsubscribe=null; deps.channel.close(); }
    function getSessionSid(): string | null { return currentSid; }
    return {refreshOnce,bootstrapSession,handleAuthFailure,clearSession,lockSession,getSessionSid,acceptChannelMessage,installLocalCredential,cancelProactive,dispose};
}
