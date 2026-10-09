import axios, { type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';
import { Agent, type RequestOptions } from 'node:https';
import { request, type ClientRequest } from 'node:http';
import { checkServerIdentity, connect as tlsConnect } from 'node:tls';
import type { Duplex } from 'node:stream';
import { managedProxyFromEnvironment } from './callback-proxy-candidate.js';
import { BridgeError } from './types.js';

const CONNECT_MS = 12000, REQUEST_MS = 15000, MAX_BODY = 262144;
const API_HOSTS = new Set(['open.feishu.cn', 'open.larksuite.com']);
const WS_HOSTS = new Set(['msg-frontier.feishu.cn', 'msg-frontier.larksuite.com']);

function permittedHost(host: string, websocket: boolean): boolean {
  if (!websocket) return API_HOSTS.has(host);
  // Deliberately conservative exact hosts. A new regional endpoint requires
  // independent review, never a vendor-wide wildcard or automatic fallback.
  return WS_HOSTS.has(host);
}

function validateDiscoveryUrl(raw: unknown, apiHost: string, onBlockedHost?: (host: string) => void): void {
  let url: URL;
  try { if (typeof raw !== 'string') throw new Error(); url = new URL(raw); }
  catch { throw new BridgeError('invalid_feishu_ws_destination'); }
  const expected = apiHost === 'open.feishu.cn' ? 'msg-frontier.feishu.cn' : 'msg-frontier.larksuite.com';
  if (url.hostname !== expected) {
    // URL query values are credentials. Only a bounded, sanitized DNS hostname
    // may be reported for follow-up review, never raw URL/error/config objects.
    if (/^[a-z0-9.-]{1,253}$/.test(url.hostname)) { try { onBlockedHost?.(url.hostname); } catch { /* Logging must not change rejection. */ } }
    throw new BridgeError('invalid_feishu_ws_destination');
  }
  if (typeof raw !== 'string' || raw.length > 4096 || /[\u0000-\u0020\u007f\\#]/.test(raw) || !raw.startsWith('wss://') || url.protocol !== 'wss:' || url.port || url.username || url.password || url.hash) throw new BridgeError('invalid_feishu_ws_destination');
}

/** Supported asynchronous Agent.createConnection extension. It owns the native
 * CONNECT request from its first socket, including before Node assigns an HTTPS
 * socket to the outer request. Agent.destroy() therefore also cancels pending
 * CONNECT/TLS work, unlike destroying only an outer request/global agent. */
class ManagedFeishuAgent extends Agent {
  private stopped = false;
  private readonly pending = new Set<() => void>();
  private readonly tracked = new Set<Duplex>();
  constructor(private readonly proxy: URL, private readonly websocket: boolean) { super({ keepAlive: false }); }
  override createConnection(options: RequestOptions, callback?: (error: Error | null, stream: Duplex) => void): undefined {
    if (!callback) throw new BridgeError('feishu_agent_callback_required');
    const hostname = options.hostname ?? options.host ?? '';
    const deliver = (error: Error | null, socket?: Duplex) => callback(error, socket as Duplex);
    if (this.stopped || options.socketPath || !permittedHost(hostname, this.websocket) || Number(options.port ?? 443) !== 443) {
      queueMicrotask(() => deliver(new BridgeError(this.stopped ? 'feishu_network_closed' : 'invalid_feishu_destination')));
      return;
    }
    let settled = false, connected = false, proxyRequest: ClientRequest | undefined;
    const sockets = new Set<Duplex>();
    const cancel = () => finish(new BridgeError('feishu_network_closed'));
    const connectTimer = setTimeout(() => finish(new BridgeError('feishu_proxy_connect_timeout')), CONNECT_MS);
    const totalTimer = setTimeout(() => finish(new BridgeError('feishu_tls_timeout')), REQUEST_MS);
    const finish = (error: Error | null, socket?: Duplex) => {
      if (settled) return;
      settled = true; clearTimeout(connectTimer); clearTimeout(totalTimer); this.pending.delete(cancel);
      if (error) { proxyRequest?.destroy(); for (const item of sockets) item.destroy(); }
      deliver(error, socket);
    };
    const track = (socket: Duplex) => {
      if (sockets.has(socket)) return;
      sockets.add(socket); this.tracked.add(socket);
      socket.once('close', () => { this.tracked.delete(socket); if (!settled) finish(new BridgeError('feishu_proxy_closed')); });
      socket.on('error', () => finish(new BridgeError('feishu_tls_or_proxy_failed')));
    };
    this.pending.add(cancel);
    try {
      proxyRequest = request({
        protocol: 'http:', hostname: this.proxy.hostname.replace(/^\[|\]$/g, ''), port: Number(this.proxy.port),
        method: 'CONNECT', path: hostname + ':443', headers: { host: hostname + ':443' }, agent: false, maxHeaderSize: 16384
      });
      proxyRequest.on('socket', track);
      proxyRequest.on('error', () => finish(new BridgeError('feishu_proxy_connect_failed')));
      proxyRequest.on('close', () => { if (!connected) finish(new BridgeError('feishu_proxy_connect_failed')); });
      proxyRequest.on('connect', (response, socket, head) => {
        track(socket);
        if (settled) { socket.destroy(); return; }
        if (response.statusCode !== 200 || head.length) { finish(new BridgeError('feishu_proxy_connect_failed')); return; }
        connected = true; clearTimeout(connectTimer);
        try {
          const secure = tlsConnect({ socket, servername: hostname, rejectUnauthorized: true, checkServerIdentity });
          track(secure);
          secure.once('secureConnect', () => {
            if (settled) { secure.destroy(); return; }
            if (!secure.authorized) { finish(new BridgeError('feishu_tls_failed')); return; }
            finish(null, secure);
          });
        } catch { finish(new BridgeError('feishu_tls_failed')); }
      });
      proxyRequest.end();
    } catch { finish(new BridgeError('feishu_proxy_connect_failed')); }
    return;
  }
  override destroy(): void {
    this.stopped = true;
    for (const cancel of [...this.pending]) cancel();
    for (const socket of this.tracked) socket.destroy();
    this.tracked.clear(); super.destroy();
  }
}

export interface FeishuNetwork {
  http: AxiosInstance;
  wsAgent: Agent;
  startupTimeoutMs: number;
  close(): void;
}

/** Explicit deployment option only. Ambient proxy variables do not change the
 * non-cloud SDK behavior. Callback transport/host validation is independent. */
export function createFeishuNetwork(env: NodeJS.ProcessEnv = process.env, onBlockedWsHost?: (host: string) => void): FeishuNetwork | undefined {
  const mode = env.FEISHU_TRANSPORT ?? 'default';
  if (mode === 'default') return undefined;
  if (mode !== 'managed-proxy') throw new BridgeError('invalid_feishu_transport');
  const proxy = new URL(managedProxyFromEnvironment(env));
  const wsAgent = new ManagedFeishuAgent(proxy, true);
  const http = axios.create({ adapter: 'http', timeout: REQUEST_MS, proxy: false, maxRedirects: 0, maxContentLength: MAX_BODY, maxBodyLength: MAX_BODY });
  const active = new Set<() => void>();
  const cleanup = new WeakMap<InternalAxiosRequestConfig, () => void>();
  let closed = false;
  http.interceptors.request.use(config => {
    if (closed) throw new BridgeError('feishu_network_closed');
    let url: URL;
    try { url = new URL(http.getUri(config)); } catch { throw new BridgeError('invalid_feishu_destination'); }
    if (url.protocol !== 'https:' || !API_HOSTS.has(url.hostname) || url.port || url.username || url.password || url.hash || url.href.length > 4096 || config.socketPath || config.transport) throw new BridgeError('invalid_feishu_destination');
    // SDK requests cannot turn a managed request into a direct, redirected or
    // unbounded one, or override the TLS agent / proxy policy per request.
    config.proxy = false; config.adapter = 'http'; config.maxRedirects = 0;
    config.maxContentLength = MAX_BODY; config.maxBodyLength = MAX_BODY;
    config.responseType = 'json'; config.validateStatus = status => status >= 200 && status < 300;
    config.timeout = config.timeout && config.timeout > 0 ? Math.min(config.timeout, REQUEST_MS) : REQUEST_MS;
    const agent = new ManagedFeishuAgent(proxy, false);
    config.httpsAgent = agent;
    const controller = new AbortController(), originalSignal = config.signal;
    config.signal = controller.signal;
    const abort = () => controller.abort();
    originalSignal?.addEventListener?.('abort', abort, { once: true });
    const timer = setTimeout(abort, config.timeout);
    let disposed = false;
    const dispose = () => {
      if (disposed) return; disposed = true;
      clearTimeout(timer); originalSignal?.removeEventListener?.('abort', abort);
      active.delete(cancel); cleanup.delete(config); agent.destroy();
    };
    const cancel = () => { abort(); dispose(); };
    cleanup.set(config, dispose); active.add(cancel);
    if (originalSignal?.aborted) abort();
    return config;
  });
  http.interceptors.response.use(response => {
    cleanup.get(response.config)?.();
    const url = new URL(http.getUri(response.config));
    if (url.pathname === '/callback/ws/endpoint' && response.data?.code === 0) validateDiscoveryUrl(response.data?.data?.URL, url.hostname, onBlockedWsHost);
    return response.data;
  }, error => {
    if (error?.config) cleanup.get(error.config)?.();
    return Promise.reject(error);
  });
  return {
    http, wsAgent, startupTimeoutMs: 35000,
    close() { if (closed) return; closed = true; for (const cancel of [...active]) cancel(); wsAgent.destroy(); }
  };
}

/** Candidate-only binary resource transport seam. Never change the JSON client's
 * body cap/response parser to enable media. No caller-supplied host is accepted. */
export function createFeishuResourceAgent(env: NodeJS.ProcessEnv): Agent {
  const mode = env.FEISHU_TRANSPORT ?? 'default';
  if (mode === 'default') return new Agent({ keepAlive: false, rejectUnauthorized: true });
  if (mode !== 'managed-proxy') throw new BridgeError('invalid_feishu_transport');
  return new ManagedFeishuAgent(new URL(managedProxyFromEnvironment(env)), false);
}
