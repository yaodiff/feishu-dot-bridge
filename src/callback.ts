import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import ipaddr from 'ipaddr.js';
import { BridgeError, type CallbackTransport, type DeliveryResponse } from './types.js';
export function isPublicAddress(address: string): boolean { try { let ip = ipaddr.parse(address); if (ip.kind() === 'ipv6' && (ip as ipaddr.IPv6).isIPv4MappedAddress()) ip = (ip as ipaddr.IPv6).toIPv4Address(); return ip.range() === 'unicast'; } catch { return false; } }
export function validateCallbackUrl(raw: string, hosts: string[]): URL {
  let url: URL; try { url = new URL(raw); } catch { throw new BridgeError('invalid_callback'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443') || !hosts.includes(url.hostname) || ipaddr.isValid(url.hostname.replace(/^\[|\]$/g, ''))) throw new BridgeError('invalid_callback');
  return url;
}
/** DNS is resolved and checked for EVERY request, then pinned into the TLS connection.
 * No redirect following, proxy, ambient cookies, auth forwarding, or arbitrary fetch hook in production. */
export class PublicHttpsCallback implements CallbackTransport {
  constructor(private allowedHosts: string[], private onBlockedHost?: (hostname: string) => void) { if (!allowedHosts.length) throw new Error('CALLBACK_HOSTS must be configured'); }
  async post(rawUrl: string, body: string, headers: Record<string, string>): Promise<DeliveryResponse> {
    // Bootstrap diagnostics expose only a canonical hostname, never capability URL paths or secrets.
    try { const candidate = new URL(rawUrl); if (!this.allowedHosts.includes(candidate.hostname) && candidate.hostname.length <= 253) this.onBlockedHost?.(candidate.hostname); } catch { /* URL validation below */ }
    const url = validateCallbackUrl(rawUrl, this.allowedHosts);
    const started = Date.now();
    let timer: NodeJS.Timeout | undefined;
    const addresses = await Promise.race([lookup(url.hostname, { all: true, verbatim: true }), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new BridgeError('callback_dns_timeout')), 5000); })]).finally(() => { clearTimeout(timer); });
    if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) throw new BridgeError('blocked_callback_address');
    const pinned = addresses[0]!;
    return new Promise((resolve, reject) => {
      const req = request(url, { method: 'POST', agent: false, servername: url.hostname, rejectUnauthorized: true,
        lookup: (_hostname, options, cb) => { if (typeof options === 'object' && options.all) cb(null, [pinned]); else cb(null, pinned.address, pinned.family); },
        headers: { ...headers, 'content-length': Buffer.byteLength(body) }, signal: AbortSignal.timeout(Math.max(1, 10000 - (Date.now() - started)))
      }, res => {
        let size = 0; const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 65536) { res.destroy(); reject(new BridgeError('callback_response_too_large')); } else chunks.push(chunk); });
        res.on('error', () => reject(new BridgeError('callback_failed')));
        res.on('end', () => resolve({ status: res.statusCode ?? 500, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', () => reject(new BridgeError('callback_failed'))); req.end(body);
    });
  }
}
