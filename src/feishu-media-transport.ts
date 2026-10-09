/** Binary transport candidate, not wired into main.ts. Never accepts URLs. */
import { request as httpsRequest, type Agent } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { BridgeError, type FeishuApp } from './types.js';
import { createFeishuResourceAgent } from './feishu-network.js';
import { MEDIA_LIMITS, mediaByteLimit, resourcePath, type MediaReference } from './media-policy.js';

export interface ResourceRequest { appId: string; messageId: string; reference: MediaReference }
export interface ResourceBytes { bytes: Buffer; declaredMime: string }
export interface MediaTransport { download(request: ResourceRequest, signal: AbortSignal, stillAuthorized: () => void): Promise<ResourceBytes> }

/** Streaming collector shared by real transport and synthetic tests. Header/body
 * errors expose fixed codes only; rejected bodies are never parsed or logged. */
export async function collectResourceResponse(response: IncomingMessage, limit: number): Promise<ResourceBytes> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    if (response.statusCode !== 200) throw new BridgeError(response.statusCode === 401 || response.statusCode === 403 ? 'media_permission_denied' : 'media_download_failed');
    const encoding = response.headers['content-encoding'];
    if (encoding && encoding !== 'identity') throw new BridgeError('media_encoding_rejected');
    const mime = response.headers['content-type'];
    if (typeof mime !== 'string' || mime.length > 128) throw new BridgeError('media_mime_missing');
    const length = response.headers['content-length'];
    if (length !== undefined && (typeof length !== 'string' || !/^[0-9]{1,12}$/.test(length) || Number(length) < 1 || Number(length) > limit)) throw new BridgeError('media_size_exceeded');
    for await (const chunk of response) {
      if (!Buffer.isBuffer(chunk)) throw new BridgeError('invalid_media_content');
      size += chunk.length;
      if (size > limit) throw new BridgeError('media_size_exceeded');
      chunks.push(chunk);
    }
    if (!response.complete || !size || (length !== undefined && size !== Number(length))) throw new BridgeError('media_truncated');
    return { bytes: Buffer.concat(chunks, size), declaredMime: mime };
  } catch (error) {
    throw error instanceof BridgeError ? error : new BridgeError('media_download_failed');
  } finally {
    response.destroy();
    for (const chunk of chunks) chunk.fill(0);
  }
}

/** A tokenProvider must reuse the already approved installation's Feishu SDK
 * token provider. This module never reads credentials or creates access grants. */
export class FeishuMediaTransport implements MediaTransport {
  private readonly apps = new Map<string, Readonly<{ domain: 'feishu' | 'lark' }>>();
  private readonly active = new Set<AbortController>();
  private closed = false;
  constructor(apps: Pick<FeishuApp, 'appId' | 'domain'>[], private readonly tokenProvider: (appId: string) => Promise<string>,
    private readonly env: NodeJS.ProcessEnv = {}, private readonly requestImpl: typeof httpsRequest = httpsRequest) {
    for (const app of apps) this.apps.set(app.appId, Object.freeze({ domain: app.domain }));
  }
  async download(input: ResourceRequest, signal: AbortSignal, stillAuthorized: () => void): Promise<ResourceBytes> {
    if (this.closed) throw new BridgeError('media_transport_closed');
    if (this.active.size >= MEDIA_LIMITS.maxConcurrent) throw new BridgeError('media_busy', 429);
    const app = this.apps.get(input.appId);
    if (!app) throw new BridgeError('unknown_app');
    const path = resourcePath(input.messageId, input.reference), limit = mediaByteLimit(input.reference.kind);
    const hostname = app.domain === 'lark' ? 'open.larksuite.com' : 'open.feishu.cn';
    const controller = new AbortController(); this.active.add(controller);
    const abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, MEDIA_LIMITS.requestMs);
    let agent: Agent | undefined;
    try {
      stillAuthorized(); if (signal.aborted) abort();
      if (controller.signal.aborted) throw new BridgeError('media_cancelled');
      // Race token acquisition too. Late provider settlement cannot trigger a request.
      const token = await Promise.race([this.tokenProvider(input.appId), new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new BridgeError('media_cancelled')), { once: true });
      })]);
      stillAuthorized();
      if (controller.signal.aborted) throw new BridgeError('media_cancelled');
      if (typeof token !== 'string' || !/^[A-Za-z0-9._~+/-]{1,4096}$/.test(token)) throw new BridgeError('media_auth_unavailable');
      agent = createFeishuResourceAgent(this.env);
      return await new Promise<ResourceBytes>((resolve, reject) => {
        const req = this.requestImpl({ hostname, port: 443, path, method: 'GET', agent, signal: controller.signal,
          maxHeaderSize: 16384, headers: { authorization: `Bearer ${token}`, accept: 'application/octet-stream', 'accept-encoding': 'identity' } }, response => {
          void collectResourceResponse(response, limit).then(resolve, reject);
        });
        req.once('error', () => reject(new BridgeError(controller.signal.aborted ? 'media_cancelled' : 'media_download_failed')));
        req.end();
      });
    } catch (error) { throw error instanceof BridgeError ? error : new BridgeError('media_download_failed'); }
    finally { clearTimeout(timer); signal.removeEventListener('abort', abort); this.active.delete(controller); agent?.destroy(); }
  }
  close(): void { this.closed = true; for (const active of this.active) active.abort(); }
}
