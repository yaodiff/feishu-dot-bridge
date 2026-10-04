import { createServer, type Server } from 'node:http';
import { Bridge } from './bridge.js';
import { BridgeError, type FeishuApp, type Principal } from './types.js';
import { decodeFeishu } from './feishu.js';
import { handleMcp } from './mcp.js';
export interface AppConfig { publicUrl: string; issuer: string; apps: FeishuApp[]; allowedOrigins: string[] }
export interface Authenticator { authenticate(header: string | null): Promise<Principal> }
export function makeApp(config: AppConfig, bridge: Bridge, auth: Authenticator) {
  const resource = `${config.publicUrl}/mcp`, metadataUrl = `${config.publicUrl}/.well-known/oauth-protected-resource/mcp`;
  const json = (body: unknown, status = 200, extra: Record<string, string> = {}) => Response.json(body, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra } });
  return async (req: Request): Promise<Response> => {
    try {
      const url = new URL(req.url);
      if (req.headers.has('origin') && !config.allowedOrigins.includes(req.headers.get('origin')!)) return json({ error: 'forbidden_origin' }, 403);
      if (req.method === 'GET' && url.pathname === '/healthz') return json({ status: 'ok', version: '0.1.0' });
      if (req.method === 'GET' && ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'].includes(url.pathname)) return json({ resource, authorization_servers: [config.issuer], scopes_supported: ['bridge:use'], bearer_methods_supported: ['header'] });
      if (url.pathname === '/mcp') {
        if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'POST' });
        const principal = await auth.authenticate(req.headers.get('authorization'));
        if (bridge.store.isRevoked(principal.id)) throw new BridgeError('unauthorized', 401);
        return await handleMcp(req, bridge, principal);
      }
      const appId = /^\/feishu\/events\/([A-Za-z0-9_-]+)$/.exec(url.pathname)?.[1];
      if (appId && req.method === 'POST') {
        const app = config.apps.find(a => a.appId === appId); if (!app) return json({ error: 'not_found' }, 404);
        if (!req.headers.get('content-type')?.startsWith('application/json')) return json({ error: 'unsupported_media_type' }, 415);
        const raw = await req.text(); if (Buffer.byteLength(raw) > 262144) return json({ error: 'body_too_large' }, 413);
        const decoded = decodeFeishu(app, raw, req.headers);
        if ('challenge' in decoded) return json(decoded);
        if ('message' in decoded) bridge.receive(decoded.message);
        // Avoid an identity/binding oracle; receipt status is not disclosed to webhook callers.
        return json({ code: 0 });
      }
      return json({ error: 'not_found' }, 404);
    } catch (error) { const status = error instanceof BridgeError ? error.status : 500; return json({ error: status === 500 ? 'internal_error' : (error as BridgeError).code }, status, status === 401 ? { 'www-authenticate': `Bearer resource_metadata="${metadataUrl}", scope="bridge:use"` } : {}); }
  };
}
/** Bounded Node HTTP adapter. Public TLS/rate limiting terminate at your reverse proxy. */
export function nodeServer(app: (r: Request) => Promise<Response>, publicUrl: string, allowedHosts: string[]): Server {
  const buckets = new Map<string, { at: number; count: number }>();
  return createServer({ requestTimeout: 15000, headersTimeout: 10000, maxHeaderSize: 16384 }, async (req, res) => {
    const host = req.headers.host ?? '';
    if (!allowedHosts.includes(host)) { res.writeHead(421); res.end(); return; }
    const ip = req.socket.remoteAddress ?? 'unknown', now = Date.now();
    if (buckets.size > 10000) { for (const [key, b] of buckets) if (now - b.at > 60000) buckets.delete(key); }
    const b = buckets.get(ip); if (b && now - b.at < 60000) { if (++b.count > 600) { res.writeHead(429, { 'retry-after': '60' }); res.end(); return; } } else buckets.set(ip, { at: now, count: 1 });
    try {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const part of req) { const data = Buffer.from(part); bytes += data.length; if (bytes > 262144) { res.writeHead(413); res.end(); return; } chunks.push(data); }
      const headers = new Headers(); for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(name, value);
      const response = await app(new Request(new URL(req.url ?? '/', publicUrl), { method: req.method, headers, ...(['GET', 'HEAD'].includes(req.method ?? 'GET') ? {} : { body: Buffer.concat(chunks) }) }));
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
    } catch { if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"internal_error"}'); }
  });
}
