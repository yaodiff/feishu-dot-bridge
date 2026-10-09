import { createHash, createDecipheriv } from 'node:crypto';
import axios from 'axios';
import * as lark from '@larksuiteoapi/node-sdk';
import { z } from 'zod';
import { classifyText } from './content-safety.js';
import { parseFeishuPost } from './feishu-post.js';
import { parseMediaReference } from './media-policy.js';
import { equal } from './crypto.js';
import { BridgeError, type FeishuApp, type Inbound, type FeishuSender } from './types.js';
import type { FeishuNetwork } from './feishu-network.js';
const id = z.string().min(1).max(256);
const messageEventSchema = z.object({ sender: z.object({ sender_type: z.string(), tenant_key: id.optional(), sender_id: z.object({ open_id: id }) }), message: z.object({ message_id: id, chat_id: id, chat_type: z.string(), message_type: z.string(), content: z.string().max(64000), create_time: z.string(), mentions: z.unknown().optional() }) });
const eventSchema = z.object({ schema: z.literal('2.0'), header: z.object({ app_id: id, tenant_key: id, token: id, event_type: id }), event: messageEventSchema });
const websocketEventSchema = messageEventSchema.extend({ app_id: id, tenant_key: id, event_type: z.literal('im.message.receive_v1') });
export type FeishuMessageResult = { message: Inbound } | { ignored: true };
function normalizeMessage(app: FeishuApp, event: z.infer<typeof messageEventSchema>, now: number, mediaCandidate = false): FeishuMessageResult {
  const { sender, message } = event;
  if (sender.tenant_key && sender.tenant_key !== app.tenantKey) throw new BridgeError('invalid_feishu_identity', 403);
  if (sender.sender_type !== 'user' || message.chat_type !== 'p2p') return { ignored: true };
  const time = Number(message.create_time);
  if (!Number.isSafeInteger(time) || time > now + 60000 || now - time > 24 * 3600000) return { ignored: true };
  const base = { appId: app.appId, tenantKey: app.tenantKey, openId: sender.sender_id.open_id, messageId: message.message_id, chatId: message.chat_id, timestamp: new Date(time).toISOString() };
  if (message.message_type === 'post') return { message: { ...base, richPost: true, ...parseFeishuPost(message.content, mediaCandidate, message.mentions) } };
  if (message.message_type !== 'text') {
    const media = mediaCandidate ? parseMediaReference(message.message_type, message.content) : undefined;
    return { message: { ...base, text: '[未同步：暂不支持此消息类型]', contentStatus: 'unsupported', ...(media ? media.supported ? { mediaCandidate: media.reference } : { mediaCandidateStatus: media.reason } : {}) } };
  }
  let text: string;
  try { text = z.object({ text: z.string().min(1).max(12000) }).parse(JSON.parse(message.content)).text; } catch { throw new BridgeError('invalid_feishu_text'); }
  // Only this exact one-use command may bypass text filtering, and receive() consumes it without forwarding.
  if (/^\/bind [A-Za-z0-9_-]{32}$/.test(text)) return { message: { ...base, text } };
  if (classifyText(text) === 'credential') return { message: { ...base, text: '[未同步：消息可能包含登录凭据或其他密钥]', contentStatus: 'credential_blocked' } };
  return { message: { ...base, text } };
}
/** Internal trusted-channel adapter ONLY. Caller must be the official SDK WS dispatcher
 * on the authenticated connection for this app, never an HTTP caller supplying plaintext.
 * The official dispatcher flattens authenticated event.header and event.event together. */
export function decodeFeishuWebSocket(app: FeishuApp, data: unknown, now = Date.now(), mediaCandidate = false): FeishuMessageResult {
  if (app.ingress !== 'websocket') throw new BridgeError('wrong_feishu_transport', 403);
  const parsed = websocketEventSchema.safeParse(data);
  if (!parsed.success) throw new BridgeError('invalid_feishu_ws_payload');
  if (parsed.data.app_id !== app.appId || parsed.data.tenant_key !== app.tenantKey) throw new BridgeError('invalid_feishu_identity', 403);
  return normalizeMessage(app, parsed.data, now, mediaCandidate);
}
export function decodeFeishu(app: FeishuApp, raw: string, headers: Headers, now = Date.now(), mediaCandidate = false): { challenge: string } | { message: Inbound } | { ignored: true } {
  if (app.ingress === 'websocket' || !app.encryptKey || !app.verificationToken) throw new BridgeError('wrong_feishu_transport', 403);
  const ts = headers.get('x-lark-request-timestamp') ?? '', nonce = headers.get('x-lark-request-nonce') ?? '', signature = headers.get('x-lark-signature') ?? '';
  if (!/^\d{10}$/.test(ts) || !nonce || nonce.length > 256 || Math.abs(now - Number(ts) * 1000) > 300000) throw new BridgeError('invalid_feishu_signature', 401);
  const expected = createHash('sha256').update(ts + nonce + app.encryptKey + raw).digest('hex');
  if (!equal(expected, signature)) throw new BridgeError('invalid_feishu_signature', 401);
  let data: unknown;
  try {
    const outer = JSON.parse(raw) as { encrypt?: unknown };
    // Require encrypted events in production; signing authenticates exact encrypted bytes first.
    if (typeof outer.encrypt !== 'string') throw new Error('encryption_required');
    const encrypted = Buffer.from(outer.encrypt, 'base64');
    const decipher = createDecipheriv('aes-256-cbc', createHash('sha256').update(app.encryptKey).digest(), encrypted.subarray(0, 16));
    data = JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(16)), decipher.final()]).toString());
  } catch { throw new BridgeError('invalid_feishu_payload', 400); }
  const challenge = z.object({ type: z.literal('url_verification'), token: z.string(), challenge: z.string().min(1).max(1024) }).safeParse(data);
  if (challenge.success) { if (!equal(challenge.data.token, app.verificationToken)) throw new BridgeError('invalid_feishu_token', 401); return { challenge: challenge.data.challenge }; }
  const parsed = eventSchema.safeParse(data);
  if (!parsed.success) throw new BridgeError('invalid_feishu_payload', 400);
  const { header, event } = parsed.data;
  if (header.app_id !== app.appId || header.tenant_key !== app.tenantKey || !equal(header.token, app.verificationToken)) throw new BridgeError('invalid_feishu_identity', 403);
  if (header.event_type !== 'im.message.receive_v1') return { ignored: true };
  return normalizeMessage(app, event, now, mediaCandidate);
}
export const silentLarkLogger = { debug() {}, info() {}, warn() {}, error() {}, trace() {} };
export function createLarkHttp(network?: FeishuNetwork) { const http = network?.http ?? axios.create({ timeout: 10000, maxRedirects: 0, maxContentLength: 262144 }); if (!network) http.interceptors.response.use(response => response.data); return http as unknown as NonNullable<ConstructorParameters<typeof lark.Client>[0]['httpInstance']>; }
export class LarkSender implements FeishuSender {
  private clients = new Map<string, lark.Client>();
  constructor(apps: FeishuApp[], network?: FeishuNetwork) {
    const http = createLarkHttp(network);
    for (const app of apps) this.clients.set(app.appId, new lark.Client({ httpInstance: http, appId: app.appId, appSecret: app.appSecret, domain: app.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu, logger: silentLarkLogger })); }
  /** Internal resource-read seam; never exposed through MCP or logs. Reuses this
   * installation's official SDK token cache, without new credentials or grants. */
  async mediaAccessToken(appId: string): Promise<string> {
    const client = this.clients.get(appId); if (!client) throw new BridgeError('unknown_app');
    const token: unknown = await client.tokenManager.getTenantAccessToken();
    if (typeof token !== 'string' || !token) throw new BridgeError('media_auth_unavailable');
    return token;
  }
  async sendBound(appId: string, chatId: string, text: string, idempotencyKey: string): Promise<string> {
    const client = this.clients.get(appId); if (!client) throw new BridgeError('unknown_app');
    const result = await client.im.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: chatId, content: JSON.stringify({ text }), msg_type: 'text', uuid: idempotencyKey } });
    if (result?.code !== 0 || !result.data?.message_id) throw new BridgeError('feishu_send_failed', 502);
    return result.data.message_id;
  }
  async reply(appId: string, messageId: string, text: string, idempotencyKey: string): Promise<void> {
    const client = this.clients.get(appId); if (!client) throw new BridgeError('unknown_app');
    const result = await client.im.message.reply({ path: { message_id: messageId }, data: { content: JSON.stringify({ text }), msg_type: 'text', uuid: idempotencyKey } });
    if (result?.code !== 0) throw new BridgeError('feishu_send_failed', 502);
  }
}
