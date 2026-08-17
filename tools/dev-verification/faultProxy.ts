import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import { activeFault, clearFaultEvidence, consumeFault, writeBarrierEvidence, writeFaultEvidence } from './faults.ts';

export const MAX_TARGET_RESPONSE_BYTES = 64 * 1024;
export type FaultProxyOptions = { stateDir: string; upstreamOrigin: string; host: '127.0.0.1'; port: number; beforeBarrierConsume?: () => Promise<void> };
type ResponseLossScenario = 'refresh_response_loss_after_commit' | 'finance_balance_response_loss_after_commit' | 'finance_refund_response_loss_after_commit' | 'site_config_response_loss_after_commit' | 'slider_response_loss_after_commit';

const hopByHop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
function forwardedHeaders(headers: IncomingHttpHeaders, buffered = false): IncomingHttpHeaders {
  const connectionTokens = String(headers.connection ?? '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  const blocked = new Set([...hopByHop, ...connectionTokens]);
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !blocked.has(name.toLowerCase()) && (!buffered || name.toLowerCase() !== 'content-length')));
}
export async function startFaultProxy(options: FaultProxyOptions): Promise<http.Server> {
  const upstream = new URL(options.upstreamOrigin);
  if (upstream.protocol !== 'http:' || upstream.hostname !== '127.0.0.1' || upstream.pathname !== '/' || upstream.search || upstream.hash) throw new Error('fault proxy upstream must be an exact loopback HTTP origin');
  await clearFaultEvidence(options.stateDir);
  const barrierQueue: Array<{ activationId: string; request: IncomingMessage; response: ServerResponse; timeout: ReturnType<typeof setTimeout> }> = [];
  const faultTimers = new Set<ReturnType<typeof setTimeout>>();
  let barrierReleasing = false;
  const lossScenario = (request: IncomingMessage): ResponseLossScenario | null => {
    const requestPath = (request.url ?? '').split('?')[0] ?? '';
    if (request.method === 'PUT' && requestPath === '/v2/settings/admin/update') return 'site_config_response_loss_after_commit';
    if (request.method === 'POST' && request.url === '/v2/auth/refresh') return 'refresh_response_loss_after_commit';
    if (request.method === 'POST' && /^\/v2\/users\/[a-f0-9]{24}\/balance$/u.test(requestPath)) return 'finance_balance_response_loss_after_commit';
    if (request.method === 'POST' && /^\/v2\/transactions\/[a-f0-9]{24}\/refund$/u.test(requestPath)) return 'finance_refund_response_loss_after_commit';
    const sliderRequestTarget = request.url ?? '';
    const sliderMutation = (request.method === 'POST' && (/^\/v2\/sliders\/admin\/create$/u.test(sliderRequestTarget) || /^\/v2\/sliders\/admin\/[a-f0-9]{24}\/(?:archive|restore)$/u.test(sliderRequestTarget)))
      || (request.method === 'PUT' && (/^\/v2\/sliders\/admin\/[a-f0-9]{24}$/u.test(sliderRequestTarget) || sliderRequestTarget === '/v2/sliders/admin/reorder'));
    if (sliderMutation) return 'slider_response_loss_after_commit';
    return null;
  };
  const forward = (request: IncomingMessage, response: ServerResponse, onUpstreamResponse?: () => void) => {
    const scenario = lossScenario(request);
    const target = scenario !== null;
    const upstreamRequest = http.request({ host: upstream.hostname, port: upstream.port, method: request.method, path: request.url, headers: forwardedHeaders(request.headers) }, (upstreamResponse) => {
      onUpstreamResponse?.();
      if (!target) {
        const abortStream = () => { if (!response.destroyed) response.destroy(); };
        upstreamResponse.on('aborted', abortStream);
        upstreamResponse.on('error', abortStream);
        response.writeHead(upstreamResponse.statusCode ?? 502, forwardedHeaders(upstreamResponse.headers));
        upstreamResponse.pipe(response);
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let terminal = false;
      const fail = () => {
        if (terminal) return;
        terminal = true;
        upstreamResponse.destroy();
        if (!response.headersSent) response.writeHead(502, { 'content-length': '0' });
        response.end();
      };
      upstreamResponse.on('data', (chunk) => {
        if (terminal) return;
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_TARGET_RESPONSE_BYTES) { fail(); return; }
        chunks.push(bytes);
      });
      upstreamResponse.on('aborted', fail);
      upstreamResponse.on('error', fail);
      upstreamResponse.on('end', async () => {
        if (terminal) return;
        terminal = true;
        try {
          const success = (upstreamResponse.statusCode ?? 0) >= 200 && (upstreamResponse.statusCode ?? 0) < 300;
          const activationId = success && scenario ? await consumeFault(options.stateDir, scenario) : null;
          if (activationId) {
            const socket = response.socket;
            if (!socket) { response.destroy(); return; }
            socket.destroy();
            if (socket.destroyed) await writeFaultEvidence(options.stateDir, activationId, scenario!);
            return;
          }
          const body = Buffer.concat(chunks);
          response.writeHead(upstreamResponse.statusCode ?? 502, { ...forwardedHeaders(upstreamResponse.headers, true), 'content-length': String(body.length) });
          response.end(body);
        } catch {
          response.destroy();
        }
      });
    });
    const cancelUpstream = () => { if (!upstreamRequest.destroyed) upstreamRequest.destroy(); };
    request.on('aborted', cancelUpstream);
    response.on('close', () => { if (!response.writableEnded) cancelUpstream(); });
    upstreamRequest.setTimeout(10_000, () => upstreamRequest.destroy(new Error('fault proxy upstream timeout')));
    request.setTimeout(10_000, () => request.destroy());
    upstreamRequest.on('error', () => {
      if (!response.headersSent) response.writeHead(502, { 'content-length': '0' });
      if (!response.writableEnded) response.end();
    });
    request.pipe(upstreamRequest);
  };
  const server = http.createServer(async (request, response) => {
    const refreshTarget = request.method === 'POST' && request.url === '/v2/auth/refresh';
    const lossTarget = lossScenario(request) !== null;
    const active = lossTarget ? await activeFault(options.stateDir) : null;
    if (refreshTarget && active && !['refresh_response_loss_after_commit', 'finance_balance_response_loss_after_commit', 'finance_refund_response_loss_after_commit', 'site_config_response_loss_after_commit', 'refresh_two_request_barrier'].includes(active.scenario)) {
      let activationId: string | null = null;
      try { activationId = await consumeFault(options.stateDir, active.scenario, active.activationId); } catch { /* bounded failure below */ }
      if (!activationId) { response.writeHead(503, { 'content-length': '0' }); response.end(); return; }
      if (active.scenario === 'offline') { response.destroy(); return; }
      if (active.scenario === 'timeout') { const timer = setTimeout(() => { faultTimers.delete(timer); if (!response.headersSent) response.writeHead(504, { 'content-length': '0' }); if (!response.writableEnded) response.end(); }, 75); faultTimers.add(timer); response.once('close', () => { clearTimeout(timer); faultTimers.delete(timer); }); return; }
      const status = Number(active.scenario.slice('status_'.length));
      if (!Number.isInteger(status) || status < 400 || status > 599) { response.writeHead(503, { 'content-length': '0' }); response.end(); return; }
      response.writeHead(status, { 'content-length': '0' }); response.end(); return;
    }
    if (!refreshTarget || active?.scenario !== 'refresh_two_request_barrier' || barrierReleasing) { forward(request, response); return; }
    const removeQueued = () => {
      const index = barrierQueue.findIndex((entry) => entry.request === request);
      if (index >= 0) barrierQueue.splice(index, 1);
    };
    const timeout = setTimeout(() => {
      removeQueued();
      request.destroy();
      if (!response.headersSent) response.writeHead(504, { 'content-length': '0' });
      if (!response.writableEnded) response.end();
    }, 10_000);
    barrierQueue.push({ activationId: active.activationId, request, response, timeout });
    response.once('close', () => { clearTimeout(timeout); removeQueued(); });
    const sameActivation = barrierQueue.filter((entry) => entry.activationId === active.activationId && !entry.request.destroyed && !entry.response.destroyed);
    if (sameActivation.length !== 2) return;
    barrierReleasing = true;
    const queued = sameActivation;
    for (const entry of queued) {
      const index = barrierQueue.indexOf(entry);
      if (index >= 0) barrierQueue.splice(index, 1);
      clearTimeout(entry.timeout);
    }
    let activationId: string | null = null;
    try {
      await options.beforeBarrierConsume?.();
      if (queued.some((entry) => entry.request.destroyed || entry.response.destroyed)) throw new Error('barrier request disconnected');
      activationId = await consumeFault(options.stateDir, 'refresh_two_request_barrier', active.activationId);
    } catch { activationId = null; }
    if (!activationId) {
      barrierReleasing = false;
      for (const entry of queued) {
        if (!entry.response.headersSent) entry.response.writeHead(503, { 'content-length': '0' });
        if (!entry.response.writableEnded) entry.response.end();
      }
      return;
    }
    let upstreamResponses = 0;
    const reachedUpstream = async () => {
      upstreamResponses += 1;
      if (upstreamResponses === 2) await writeBarrierEvidence(options.stateDir, activationId);
    };
    for (const entry of queued) forward(entry.request, entry.response, () => {
      void reachedUpstream().catch(() => { for (const failed of queued) if (!failed.response.destroyed) failed.response.destroy(); });
    });
    barrierReleasing = false;
  });
  const nativeClose = server.close.bind(server);
  server.close = ((callback?: (error?: Error) => void) => {
    barrierReleasing = false;
    for (const timer of faultTimers) clearTimeout(timer);
    faultTimers.clear();
    for (const entry of barrierQueue.splice(0)) { clearTimeout(entry.timeout); entry.request.destroy(); if (!entry.response.destroyed) entry.response.destroy(); }
    server.closeIdleConnections();
    return nativeClose(callback);
  }) as typeof server.close;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port, options.host, resolve); });
  return server;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const stateDir = process.env.DEV_VERIFICATION_STATE_DIR;
  const upstreamOrigin = process.env.DEV_VERIFICATION_RUST_ORIGIN;
  const port = Number(process.env.DEV_VERIFICATION_FAULT_PROXY_PORT);
  if (!stateDir || !upstreamOrigin || !Number.isInteger(port)) throw new Error('fault proxy environment is incomplete');
  startFaultProxy({ stateDir, upstreamOrigin, host: '127.0.0.1', port }).catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'fault proxy startup failed'); process.exitCode = 1; });
}
