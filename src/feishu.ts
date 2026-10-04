import { createHash, createDecipheriv } from 'node:crypto';
import axios from 'axios';
import * as lark from '@larksuiteoapi/node-sdk';
import { z } from 'zod';
import { equal } from './crypto.js';
import { BridgeError, type FeishuApp, type Inbound, type FeishuSender } from './types.js';
const id = z.string().min(1).max(256);
const eventSchema = z.object({ schema: z.literal('2.0'), header: z.object({ app_id: id, tenant_key: id, token: id, event_type: id }), event: z.object({ sender: z.object({ sender_type: z.string(), tenant_key: id.optional(), sender_id: z.object({ open_id: id }) }), message: z.object({ message_id: id, chat_id: id, chat_type: z.string(), message_type: z.string(), content: z.string().max(64000), create_time: z.string() }) }) });
export function decodeFeishu(app: FeishuApp, raw: string, headers: Headers, now = Date.now()): { challenge: string } | { message: Inbound } | { ignored: true } {
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
  const { header, event: { sender, message } } = parsed.data;
  if (header.app_id !== app.appId || header.tenant_key !== app.tenantKey || (sender.tenant_key && sender.tenant_key !== app.tenantKey) || !equal(header.token, app.verificationToken)) throw new BridgeError('invalid_feishu_identity', 403);
  if (header.event_type !== 'im.message.receive_v1' || sender.sender_type !== 'user' || message.chat_type !== 'p2p' || message.message_type !== 'text') return { ignored: true };
  let text: string;
  try { text = z.object({ text: z.string().min(1).max(12000) }).parse(JSON.parse(message.content)).text; } catch { throw new BridgeError('invalid_feishu_text'); }
  const time = Number(message.create_time);
  if (!Number.isSafeInteger(time) || time > now + 60000 || now - time > 24 * 3600000) return { ignored: true };
  return { message: { appId: app.appId, tenantKey: app.tenantKey, openId: sender.sender_id.open_id, messageId: message.message_id, chatId: message.chat_id, text, timestamp: new Date(time).toISOString() } };
}
export class LarkSender implements FeishuSender {
  private clients = new Map<string, lark.Client>();
  constructor(apps: FeishuApp[]) {
    const http = axios.create({ timeout: 10000, maxRedirects: 0, maxContentLength: 262144 });
    http.interceptors.response.use(response => response.data);
    for (const app of apps) this.clients.set(app.appId, new lark.Client({ httpInstance: http as unknown as NonNullable<ConstructorParameters<typeof lark.Client>[0]['httpInstance']>, appId: app.appId, appSecret: app.appSecret, domain: app.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu, logger: { debug() {}, info() {}, warn() {}, error() {}, trace() {} } })); }
  async reply(appId: string, messageId: string, text: string, idempotencyKey: string): Promise<void> {
    const client = this.clients.get(appId); if (!client) throw new BridgeError('unknown_app');
    const result = await client.im.message.reply({ path: { message_id: messageId }, data: { content: JSON.stringify({ text }), msg_type: 'text', uuid: idempotencyKey } });
    if (result?.code !== 0) throw new BridgeError('feishu_send_failed', 502);
  }
}
