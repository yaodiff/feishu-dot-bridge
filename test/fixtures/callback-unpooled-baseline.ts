
import { Agent, request as httpsRequest } from 'node:https';
import { request as httpRequest, validateHeaderValue, type ClientRequest } from 'node:http';
import type { Duplex } from 'node:stream';
import { checkServerIdentity, connect as tlsConnect } from 'node:tls';
import { BridgeError, type CallbackTransport, type DeliveryResponse } from '../../src/types.js';

export const OPENAI_CALLBACK_HOST = 'connectors.api.openai.com';
const MAX_REQUEST = 262144, MAX_RESPONSE = 65536, MAX_URL = 4096, CONNECT_DEADLINE_MS = 10000, DEADLINE_MS = 15000;
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

export class OpenAiManagedProxyCallback implements CallbackTransport {
  readonly assurance = Object.freeze({ exactHost: OPENAI_CALLBACK_HOST, applicationDnsPinning: false, mode: 'managed-proxy-openai' });
  private readonly proxy: string;
  constructor(env: NodeJS.ProcessEnv = process.env, private readonly onDiagnostic?: CallbackPostDiagnosticHook) { this.proxy = managedProxyFromEnvironment(env); }
  async post(rawUrl: string, body: string, headers: Record<string, string>): Promise<DeliveryResponse> {
    const diagnostic = postDiagnostics(this.onDiagnostic);
    diagnostic('validation', 'started');
    let url: URL, checkedHeaders: Record<string, string>, hostname: typeof OPENAI_CALLBACK_HOST | undefined;
    try {
      url = validateOpenAiCallback(rawUrl); hostname = OPENAI_CALLBACK_HOST;
      if (typeof body !== 'string' || Buffer.byteLength(body) > MAX_REQUEST) throw new BridgeError('callback_request_too_large');
      checkedHeaders = safeHeaders(headers);
    } catch (error) { diagnostic('validation', 'failed', diagnosticReason(error), hostname); throw error; }
    diagnostic('validation', 'succeeded', 'none', hostname);
    return this.send(url, 'POST', body, checkedHeaders, diagnostic);
  }
  /** Public root HEAD only: no callback capability path, credential, or user data. */
  async probe(): Promise<DeliveryResponse> { return this.send(validateOpenAiCallback('https://' + OPENAI_CALLBACK_HOST + '/'), 'HEAD', '', {}); }
  private async send(url: URL, method: 'POST' | 'HEAD', body: string, headers: Record<string, string>, diagnostic?: PostDiagnostics): Promise<DeliveryResponse> {
    // Native CONNECT makes the pending proxy socket observable from the start.
    // Every socket/request is tracked and destroyed on the absolute deadline.
    const proxy = new URL(this.proxy);
    return await new Promise<DeliveryResponse>((resolve, reject) => {
      const sockets = new Set<Duplex>();
      let proxyReq: ClientRequest | undefined, outbound: ClientRequest | undefined, agent: Agent | undefined;
      let settled = false, tunnelReady = false, responseStarted = false;
      let stage: CallbackPostStage = 'proxy_connect', httpStatus: number | undefined;
      const deadline = setTimeout(() => finish(new BridgeError('callback_timeout')), DEADLINE_MS);
      const connectDeadline = setTimeout(() => finish(new BridgeError('callback_proxy_connect_failed')), CONNECT_DEADLINE_MS);
      diagnostic?.(stage, 'started', 'none', OPENAI_CALLBACK_HOST);
      function finish(error?: BridgeError, response?: DeliveryResponse) {
        if (settled) return; settled = true;
        clearTimeout(deadline); clearTimeout(connectDeadline);
        proxyReq?.destroy(); outbound?.destroy(); agent?.destroy();
        for (const socket of sockets) socket.destroy();
        diagnostic?.(stage, error ? 'failed' : 'succeeded', error ? diagnosticReason(error) : 'none', OPENAI_CALLBACK_HOST, httpStatus);
        if (error) reject(error); else resolve(response!);
      }
      function track(socket: Duplex) { sockets.add(socket); socket.on('error', error => finish(safeFailure(error))); }
      try { proxyReq = httpRequest({
        protocol: 'http:', hostname: proxy.hostname.replace(/^\[|\]$/g, ''), port: Number(proxy.port),
        method: 'CONNECT', path: OPENAI_CALLBACK_HOST + ':443', headers: { host: OPENAI_CALLBACK_HOST + ':443' },
        agent: false, maxHeaderSize: 16384
      }); } catch (error) { finish(safeFailure(error)); return; }
      proxyReq.on('socket', track);
      proxyReq.on('error', () => finish(new BridgeError('callback_proxy_connect_failed')));
      proxyReq.on('close', () => { if (!tunnelReady) finish(new BridgeError('callback_proxy_connect_failed')); });
      proxyReq.on('connect', (response, socket, head) => {
        try {
        track(socket);
        if (settled) { socket.destroy(); return; }
        httpStatus = response.statusCode;
        if (response.statusCode !== 200 || head.length) { finish(new BridgeError('callback_proxy_connect_failed')); return; }
        tunnelReady = true; clearTimeout(connectDeadline);
        diagnostic?.(stage, 'succeeded', 'none', OPENAI_CALLBACK_HOST, httpStatus);
        stage = 'tls_handshake'; httpStatus = undefined;
        diagnostic?.(stage, 'started', 'none', OPENAI_CALLBACK_HOST);
        const tlsSocket = tlsConnect({ socket, servername: OPENAI_CALLBACK_HOST, rejectUnauthorized: true, checkServerIdentity });
        track(tlsSocket);
        tlsSocket.once('close', () => { if (!responseStarted) finish(new BridgeError('callback_failed')); });
        tlsSocket.once('secureConnect', () => {
          try {
          if (settled) { tlsSocket.destroy(); return; }
          if (!tlsSocket.authorized) { finish(new BridgeError('callback_tls_failed')); return; }
          diagnostic?.(stage, 'succeeded', 'none', OPENAI_CALLBACK_HOST);
          stage = 'request'; diagnostic?.(stage, 'started', 'none', OPENAI_CALLBACK_HOST);
          agent = new Agent({ keepAlive: false });
          // Supported Agent extension, owned by this transport. There is no
          // caller-provided connector and no route to a direct fallback.
          agent.createConnection = () => tlsSocket;
          outbound = httpsRequest({
            protocol: 'https:', hostname: OPENAI_CALLBACK_HOST, port: 443, path: url.pathname + url.search,
            method, agent, servername: OPENAI_CALLBACK_HOST, rejectUnauthorized: true, checkServerIdentity,
            maxHeaderSize: 16384,
            headers: { ...headers, ...(method === 'POST' ? { 'content-length': Buffer.byteLength(body) } : {}) }
          }, res => {
            responseStarted = true;
            stage = 'response'; httpStatus = res.statusCode;
            if (!settled) diagnostic?.(stage, 'started', 'none', OPENAI_CALLBACK_HOST, httpStatus);
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
            res.on('end', () => finish(undefined, { status: res.statusCode ?? 500, body: Buffer.concat(chunks).toString('utf8') }));
          });
          outbound.on('upgrade', (response, upgraded) => { track(upgraded); stage = 'response'; httpStatus = response.statusCode; finish(new BridgeError('callback_upgrade_rejected')); });
          outbound.once('finish', () => {
            if (settled || stage !== 'request') return;
            diagnostic?.(stage, 'succeeded', 'none', OPENAI_CALLBACK_HOST);
            stage = 'response'; diagnostic?.(stage, 'started', 'none', OPENAI_CALLBACK_HOST);
          });
          outbound.on('error', error => finish(safeFailure(error)));
          outbound.on('close', () => { if (!responseStarted) finish(new BridgeError('callback_failed')); });
          outbound.end(body);
          } catch (error) { finish(safeFailure(error)); }
        });
        } catch (error) { finish(safeFailure(error)); }
      });
      proxyReq.end();
    });
  }
}
