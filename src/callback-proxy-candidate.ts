
import { Agent, request as httpsRequest } from 'node:https';
import { request as httpRequest, validateHeaderValue, type ClientRequest } from 'node:http';
import type { Duplex } from 'node:stream';
import { checkServerIdentity, connect as tlsConnect, type TLSSocket } from 'node:tls';
import { BridgeError, type CallbackTransport, type DeliveryResponse } from './types.js';

export const OPENAI_CALLBACK_HOST = 'connectors.api.openai.com';
const MAX_REQUEST = 262144, MAX_RESPONSE = 65536, MAX_URL = 4096, CONNECT_DEADLINE_MS = 12000, DEADLINE_MS = 15000;
const REQUIRED_HEADERS = ['content-type', 'webhook-id', 'webhook-timestamp', 'webhook-signature', 'x-mcp-subscription-id'];

export type CallbackPostStage = 'validation' | 'proxy_connect' | 'tls_handshake' | 'request' | 'response';
export type CallbackPostOutcome = 'started' | 'succeeded' | 'failed';
const DIAGNOSTIC_REASONS = [
  'none', 'invalid_callback', 'invalid_callback_headers', 'callback_request_too_large',
  'callback_timeout', 'callback_proxy_connect_failed', 'callback_tls_failed', 'callback_failed',
  'callback_redirect_rejected', 'callback_response_too_large', 'callback_upgrade_rejected'
] as const;
export type CallbackPostReason = typeof DIAGNOSTIC_REASONS[number];
/** A transport-only observation. Success does not imply a 2xx status or a valid
 * challenge echo. Never add request/response content or raw error text here. */
export interface CallbackPostDiagnostic {
  readonly stage: CallbackPostStage;
  readonly outcome: CallbackPostOutcome;
  readonly reason: CallbackPostReason;
  readonly elapsedMs: number;
  readonly httpStatus?: number;
  readonly hostname?: typeof OPENAI_CALLBACK_HOST;
}
export type CallbackPostDiagnosticHook = (diagnostic: Readonly<CallbackPostDiagnostic>) => void;

function diagnosticReason(error: unknown): CallbackPostReason {
  const code = error instanceof BridgeError ? error.code : 'callback_failed';
  return DIAGNOSTIC_REASONS.includes(code as CallbackPostReason) && code !== 'none' ? code as CallbackPostReason : 'callback_failed';
}

function postDiagnostics(hook?: CallbackPostDiagnosticHook) {
  const started = performance.now();
  return (stage: CallbackPostStage, outcome: CallbackPostOutcome, reason: CallbackPostReason = 'none', hostname?: typeof OPENAI_CALLBACK_HOST, httpStatus?: number) => {
    if (!hook) return;
    const diagnostic: CallbackPostDiagnostic = Object.freeze({
      stage, outcome, reason, elapsedMs: Math.max(0, Math.round(performance.now() - started)),
      ...(hostname === OPENAI_CALLBACK_HOST ? { hostname } : {}),
      ...(Number.isInteger(httpStatus) && httpStatus! >= 100 && httpStatus! <= 599 ? { httpStatus } : {})
    });
    // Logging must not change callback behavior, even if a hook throws or is async.
    try { void Promise.resolve(hook(diagnostic)).catch(() => {}); } catch { /* Observation only. */ }
  };
}
type PostDiagnostics = ReturnType<typeof postDiagnostics>;

/** Explicit opt-in transport. This deliberately does NOT claim application-side public-IP
 * validation or DNS pinning. The trusted managed proxy owns remote DNS/egress.
 * Selection requires the explicit managed-proxy-openai runtime mode. */
export function validateOpenAiCallback(raw: string): URL {
  if (typeof raw !== 'string' || raw.length > MAX_URL || /[\u0000-\u0020\u007f\\#]/.test(raw) || !/^https:\/\/connectors\.api\.openai\.com(?::443)?(?:\/|\?|$)/.test(raw)) throw new BridgeError('invalid_callback');
  let url: URL; try { url = new URL(raw); } catch { throw new BridgeError('invalid_callback'); }
  if (url.protocol !== 'https:' || url.hostname !== OPENAI_CALLBACK_HOST || url.username || url.password || url.hash || (url.port && url.port !== '443')) throw new BridgeError('invalid_callback');
  return url;
}

/** Read deployment-owned proxy metadata only, never request/tool arguments.
 * The marker identifies the expected runtime shape; it is NOT proof that its
 * private-IP filtering/pinning policy satisfies this bridge's threat model. */
export function managedProxyFromEnvironment(env: NodeJS.ProcessEnv): string {
  if (env.CODEX_NETWORK_PROXY_ACTIVE !== '1') throw new BridgeError('managed_proxy_required');
  const upper = env.HTTPS_PROXY, lower = env.https_proxy;
  if (upper && lower && upper !== lower) throw new BridgeError('ambiguous_managed_proxy');
  const raw = lower ?? upper;
  if (!raw || raw.trim() !== raw) throw new BridgeError('managed_proxy_required');
  if (!/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[1-9]\d{0,4}\/?$/.test(raw)) throw new BridgeError('invalid_managed_proxy');
  let url: URL; try { url = new URL(raw); } catch { throw new BridgeError('invalid_managed_proxy'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port || Number(url.port) < 1 || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new BridgeError('invalid_managed_proxy');
  return url.origin;
}

function safeHeaders(input: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(input)) {
    const name = rawName.toLowerCase();
    if (!REQUIRED_HEADERS.includes(name) || name in headers || typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) throw new BridgeError('invalid_callback_headers');
    try { validateHeaderValue(name, value); } catch { throw new BridgeError('invalid_callback_headers'); }
    headers[name] = value;
  }
  if (REQUIRED_HEADERS.some(name => !headers[name]) || headers['content-type'] !== 'application/json' || !/^\d{1,12}$/.test(headers['webhook-timestamp']!)) throw new BridgeError('invalid_callback_headers');
  if (Object.entries(headers).reduce((n, [k, v]) => n + k.length + v.length, 0) > 12288) throw new BridgeError('invalid_callback_headers');
  return headers;
}

function safeFailure(error: unknown): BridgeError {
  if (error instanceof BridgeError) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? '';
  if (code === 'ABORT_ERR' || code === 'ETIMEDOUT') return new BridgeError('callback_timeout');
  if (code === 'ERR_PROXY_TUNNEL') return new BridgeError('callback_proxy_connect_failed');
  if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/.test(code)) return new BridgeError('callback_tls_failed');
  return new BridgeError('callback_failed');
}

/** Per transport instance, fixed authority, no ambient/global Agent. These are
 * deliberately code-owned limits, not request arguments or environment knobs. */
export const CALLBACK_POOL_LIMITS = Object.freeze({ connections: 2, queued: 32, idleMs: 30000, requestsPerConnection: 100 });
interface Tunnel {
  readonly sockets: Set<Duplex>;
  busy: boolean;
  disposed: boolean;
  requests: number;
  idleSince?: number;
  idleTimer?: NodeJS.Timeout;
  proxyRequest?: ClientRequest;
  socket?: TLSSocket;
  agent?: Agent;
}
interface Waiter {
  signal: AbortSignal;
  resolve: (entry: Tunnel) => void;
  reject: (error: BridgeError) => void;
  onAbort: () => void;
}

export class OpenAiManagedProxyCallback implements CallbackTransport {
  readonly assurance = Object.freeze({ exactHost: OPENAI_CALLBACK_HOST, applicationDnsPinning: false, mode: 'managed-proxy-openai' });
  private readonly proxy: string;
  private readonly tunnels = new Set<Tunnel>();
  private readonly waiting: Waiter[] = [];
  private readonly operations = new Set<AbortController>();
  private closed = false;
  constructor(env: NodeJS.ProcessEnv = process.env, private readonly onDiagnostic?: CallbackPostDiagnosticHook) { this.proxy = managedProxyFromEnvironment(env); }
  async post(rawUrl: string, body: string, headers: Record<string, string>, options?: { signal?: AbortSignal }): Promise<DeliveryResponse> {
    const diagnostic = postDiagnostics(this.onDiagnostic);
    diagnostic('validation', 'started');
    let url: URL, checkedHeaders: Record<string, string>, hostname: typeof OPENAI_CALLBACK_HOST | undefined;
    try {
      url = validateOpenAiCallback(rawUrl); hostname = OPENAI_CALLBACK_HOST;
      if (typeof body !== 'string' || Buffer.byteLength(body) > MAX_REQUEST) throw new BridgeError('callback_request_too_large');
      checkedHeaders = safeHeaders(headers);
    } catch (error) { diagnostic('validation', 'failed', diagnosticReason(error), hostname); throw error; }
    diagnostic('validation', 'succeeded', 'none', hostname);
    return this.send(url, 'POST', body, checkedHeaders, diagnostic, options?.signal);
  }
  /** Public root HEAD only: no callback capability path, credential, or user data. */
  async probe(): Promise<DeliveryResponse> { return this.send(validateOpenAiCallback('https://' + OPENAI_CALLBACK_HOST + '/'), 'HEAD', '', {}); }
  /** Idempotent shutdown owns queued, connecting, active and idle resources. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const operation of this.operations) operation.abort(new BridgeError('callback_failed'));
    for (const tunnel of this.tunnels) this.discard(tunnel);
  }
  private discard(entry: Tunnel, drain = true): void {
    if (entry.disposed) return;
    entry.disposed = true;
    clearTimeout(entry.idleTimer);
    this.tunnels.delete(entry);
    entry.proxyRequest?.destroy();
    entry.agent?.destroy();
    for (const socket of entry.sockets) socket.destroy();
    if (drain) this.drain();
  }
  private usable(entry: Tunnel): boolean {
    return !entry.disposed && !!entry.socket && !entry.socket.destroyed && !entry.socket.readableEnded && !entry.socket.writableEnded && entry.socket.authorized &&
      entry.requests < CALLBACK_POOL_LIMITS.requestsPerConnection && (entry.idleSince === undefined || performance.now() - entry.idleSince < CALLBACK_POOL_LIMITS.idleMs);
  }
  private reserve(): Tunnel | undefined {
    for (const entry of this.tunnels) {
      if (entry.busy) continue;
      if (!this.usable(entry)) { this.discard(entry, false); continue; }
      clearTimeout(entry.idleTimer); entry.idleTimer = undefined; entry.idleSince = undefined; entry.busy = true;
      return entry;
    }
    if (this.tunnels.size >= CALLBACK_POOL_LIMITS.connections) return;
    const entry: Tunnel = { sockets: new Set(), busy: true, disposed: false, requests: 0 };
    this.tunnels.add(entry);
    return entry;
  }
  private drain(): void {
    if (this.closed) return;
    while (this.waiting.length) {
      const first = this.waiting[0]!;
      if (first.signal.aborted) { first.onAbort(); continue; }
      const entry = this.reserve();
      if (!entry) return;
      this.waiting.shift(); first.signal.removeEventListener('abort', first.onAbort); first.resolve(entry);
    }
  }
  private acquire(signal: AbortSignal): Promise<Tunnel> {
    if (this.closed) return Promise.reject(new BridgeError('callback_failed'));
    if (signal.aborted) return Promise.reject(safeFailure(signal.reason));
    if (!this.waiting.length) { const entry = this.reserve(); if (entry) return Promise.resolve(entry); }
    if (this.waiting.length >= CALLBACK_POOL_LIMITS.queued) return Promise.reject(new BridgeError('callback_failed'));
    return new Promise<Tunnel>((resolve, reject) => {
      const waiter: Waiter = { signal, resolve, reject, onAbort: () => {
        const index = this.waiting.indexOf(waiter);
        if (index < 0) return;
        this.waiting.splice(index, 1); signal.removeEventListener('abort', waiter.onAbort);
        reject(safeFailure(signal.reason));
      } };
      this.waiting.push(waiter); signal.addEventListener('abort', waiter.onAbort, { once: true });
    });
  }
  private async release(entry: Tunnel): Promise<void> {
    // IncomingMessage 'end' precedes Agent's free-socket bookkeeping. Keep the
    // lease exclusive through that turn; never hand out a still-owned socket.
    await new Promise<void>(resolve => setImmediate(resolve));
    const free = entry.agent && Object.values(entry.agent.freeSockets).some(sockets => sockets?.includes(entry.socket!));
    if (this.closed || !this.usable(entry) || !free) { this.discard(entry); return; }
    entry.busy = false; entry.idleSince = performance.now();
    entry.idleTimer = setTimeout(() => this.discard(entry), CALLBACK_POOL_LIMITS.idleMs);
    entry.idleTimer.unref();
    this.drain();
  }
  private track(entry: Tunnel, socket: Duplex): void {
    if (entry.sockets.has(socket)) return;
    entry.sockets.add(socket);
    // Idle peer closes/errors evict immediately. During an active lease, the
    // operation's own listeners reject only that request. No implicit resend.
    socket.on('error', () => this.discard(entry));
    socket.once('end', () => this.discard(entry));
    socket.once('close', () => this.discard(entry));
    // A CONNECT socket event may arrive after its request was cancelled.
    // Discard owns even these late-assigned resources.
    if (entry.disposed) socket.destroy();
  }
  private async connect(entry: Tunnel, signal: AbortSignal, progress: (stage: CallbackPostStage, outcome: CallbackPostOutcome, status?: number) => void): Promise<void> {
    const proxy = new URL(this.proxy);
    await new Promise<void>((resolve, reject) => {
      let settled = false, tunnelReady = false;
      const deadline = setTimeout(() => finish(new BridgeError('callback_proxy_connect_failed')), CONNECT_DEADLINE_MS);
      const onAbort = () => finish(safeFailure(signal.reason));
      const finish = (error?: BridgeError) => {
        if (settled) return; settled = true;
        clearTimeout(deadline); signal.removeEventListener('abort', onAbort);
        if (error) { this.discard(entry); reject(error); } else resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted || entry.disposed) { finish(signal.aborted ? safeFailure(signal.reason) : new BridgeError('callback_failed')); return; }
      progress('proxy_connect', 'started');
      if (settled) return; // A diagnostic observer may synchronously cancel.
      try {
        const request = entry.proxyRequest = httpRequest({
          protocol: 'http:', hostname: proxy.hostname.replace(/^\[|\]$/g, ''), port: Number(proxy.port),
          method: 'CONNECT', path: OPENAI_CALLBACK_HOST + ':443', headers: { host: OPENAI_CALLBACK_HOST + ':443' },
          agent: false, maxHeaderSize: 16384
        });
        request.on('socket', socket => this.track(entry, socket));
        request.on('error', () => finish(new BridgeError('callback_proxy_connect_failed')));
        request.on('close', () => { if (!tunnelReady) finish(new BridgeError('callback_proxy_connect_failed')); });
        request.on('connect', (response, socket, head) => {
          this.track(entry, socket);
          if (settled) { socket.destroy(); return; }
          if (response.statusCode !== 200 || head.length) {
            // Preserve the proxy status as sanitized diagnostics only.
            progress('proxy_connect', 'started', response.statusCode);
            finish(new BridgeError('callback_proxy_connect_failed')); return;
          }
          tunnelReady = true; clearTimeout(deadline);
          progress('proxy_connect', 'succeeded', response.statusCode);
          progress('tls_handshake', 'started');
          if (settled) return;
          try {
            const secure = entry.socket = tlsConnect({ socket, servername: OPENAI_CALLBACK_HOST, rejectUnauthorized: true, checkServerIdentity, ALPNProtocols: ['http/1.1'] });
            this.track(entry, secure);
            secure.on('error', error => finish(safeFailure(error)));
            secure.once('close', () => finish(new BridgeError('callback_failed')));
            secure.once('secureConnect', () => {
              if (settled) { secure.destroy(); return; }
              if (!secure.authorized) { finish(new BridgeError('callback_tls_failed')); return; }
              const agent = entry.agent = new Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1, maxTotalSockets: 1, maxCachedSessions: 0 });
              let assigned = false;
              // Exactly one authenticated tunnel per Agent. If it goes stale,
              // do not silently open another socket or replay a signed POST.
              agent.createConnection = (_options, callback) => {
                if (assigned || entry.disposed || secure.destroyed) {
                  // Agent can invoke this from a socket-close event as well as
                  // from https.request(). Report failure through its callback,
                  // never throw into a later native event or open a replacement.
                  callback?.(new BridgeError('callback_failed'), secure);
                  return undefined;
                }
                assigned = true; return secure;
              };
              progress('tls_handshake', 'succeeded'); finish();
            });
          } catch (error) { finish(safeFailure(error)); }
        });
        request.end();
      } catch (error) { finish(safeFailure(error)); }
    });
  }
  private async send(url: URL, method: 'POST' | 'HEAD', body: string, headers: Record<string, string>, diagnostic?: PostDiagnostics, externalSignal?: AbortSignal): Promise<DeliveryResponse> {
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort(new BridgeError('callback_timeout'));
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
    if (externalSignal?.aborted) onExternalAbort();
    this.operations.add(controller);
    // One wall-clock budget starts BEFORE queue acquisition, including CONNECT,
    // TLS and the response. Socket activity cannot extend either deadline.
    const deadline = setTimeout(() => controller.abort(new BridgeError('callback_timeout')), DEADLINE_MS);
    let entry: Tunnel | undefined;
    let stage: CallbackPostStage = 'request', httpStatus: number | undefined;
    const progress = (next: CallbackPostStage, outcome: CallbackPostOutcome, status?: number) => {
      stage = next; httpStatus = status;
      diagnostic?.(stage, outcome, 'none', OPENAI_CALLBACK_HOST, httpStatus);
    };
    try {
      entry = await this.acquire(controller.signal);
      if (!entry.socket) await this.connect(entry, controller.signal, progress);
      if (controller.signal.aborted) throw safeFailure(controller.signal.reason);
      entry.requests++;
      progress('request', 'started');
      const response = await this.exchange(entry, url, method, body, headers, controller.signal, progress);
      diagnostic?.(stage, 'succeeded', 'none', OPENAI_CALLBACK_HOST, httpStatus);
      await this.release(entry);
      return response;
    } catch (error) {
      if (entry) this.discard(entry);
      const safe = safeFailure(error);
      diagnostic?.(stage, 'failed', diagnosticReason(safe), OPENAI_CALLBACK_HOST, httpStatus);
      throw safe;
    } finally {
      clearTimeout(deadline); externalSignal?.removeEventListener('abort', onExternalAbort); this.operations.delete(controller);
    }
  }
  private async exchange(entry: Tunnel, url: URL, method: 'POST' | 'HEAD', body: string, headers: Record<string, string>, signal: AbortSignal, progress: (stage: CallbackPostStage, outcome: CallbackPostOutcome, status?: number) => void): Promise<DeliveryResponse> {
    return new Promise<DeliveryResponse>((resolve, reject) => {
      let settled = false, responseStarted = false;
      let outbound: ClientRequest | undefined;
      const onAbort = () => finish(safeFailure(signal.reason));
      const finish = (error?: BridgeError, response?: DeliveryResponse) => {
        if (settled) return; settled = true;
        signal.removeEventListener('abort', onAbort);
        if (error) { outbound?.destroy(); this.discard(entry); reject(error); } else resolve(response!);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted || entry.disposed) { finish(signal.aborted ? safeFailure(signal.reason) : new BridgeError('callback_failed')); return; }
      try {
        outbound = httpsRequest({
          protocol: 'https:', hostname: OPENAI_CALLBACK_HOST, port: 443, path: url.pathname + url.search,
          method, agent: entry.agent, servername: OPENAI_CALLBACK_HOST, rejectUnauthorized: true, checkServerIdentity,
          maxHeaderSize: 16384,
          headers: { ...headers, ...(method === 'POST' ? { 'content-length': Buffer.byteLength(body) } : {}) }
        }, res => {
          responseStarted = true; progress('response', 'started', res.statusCode);
          let size = 0; const chunks: Buffer[] = [];
          if ((res.statusCode ?? 0) >= 300 && (res.statusCode ?? 0) < 400) { finish(new BridgeError('callback_redirect_rejected')); return; }
          res.on('data', (part: Buffer) => {
            size += part.length;
            if (size > MAX_RESPONSE) finish(new BridgeError('callback_response_too_large'));
            else chunks.push(part);
          });
          res.on('aborted', () => finish(new BridgeError('callback_failed')));
          res.on('error', error => finish(safeFailure(error)));
          res.on('close', () => { if (!res.complete) finish(new BridgeError('callback_failed')); });
          res.on('end', () => {
            if (!res.complete) { finish(new BridgeError('callback_failed')); return; }
            finish(undefined, { status: res.statusCode ?? 500, body: Buffer.concat(chunks).toString('utf8') });
          });
        });
        outbound.on('upgrade', (response, upgraded) => { this.track(entry, upgraded); progress('response', 'started', response.statusCode); finish(new BridgeError('callback_upgrade_rejected')); });
        outbound.once('finish', () => { if (!settled && !responseStarted) { progress('request', 'succeeded'); progress('response', 'started'); } });
        outbound.on('error', error => finish(safeFailure(error)));
        outbound.on('close', () => { if (!responseStarted) finish(new BridgeError('callback_failed')); });
        outbound.end(body);
      } catch (error) { finish(safeFailure(error)); }
    });
  }
}
