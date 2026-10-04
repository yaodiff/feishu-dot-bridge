/** MOCK-ONLY fixtures: never imported by production src/. No real credentials or external calls. */
import { randomBytes, createCipheriv, createHash } from 'node:crypto';
import { Webhook } from 'standardwebhooks';
import { Bridge } from '../src/bridge.js';
import { Store } from '../src/store.js';
import { SecretBox } from '../src/crypto.js';
import type { FeishuApp, Inbound, CallbackTransport, DeliveryResponse, FeishuSender } from '../src/types.js';
export const mockApp: FeishuApp = { appId: 'cli_mock', tenantKey: 'tenant_mock', appSecret: 'MOCK_NOT_A_CREDENTIAL', encryptKey: 'MOCK_ENCRYPT_KEY', verificationToken: 'MOCK_VERIFY_TOKEN', domain: 'feishu' };
export function fixture(path = ':memory:') {
  let now = Date.now(); const secret = `whsec_${randomBytes(32).toString('base64')}`;
  const calls: { url: string; body: Record<string, any>; headers: Record<string, string> }[] = [];
  const sent: { appId: string; messageId: string; text: string; key: string }[] = [];
  const transport: CallbackTransport = { async post(url, body, headers): Promise<DeliveryResponse> { calls.push({ url, body: JSON.parse(body), headers }); const data = JSON.parse(body); return { status: 200, body: data.type === 'verification' ? JSON.stringify({ challenge: data.challenge }) : '{}' }; } };
  const sender: FeishuSender = { async reply(appId, messageId, text, key) { sent.push({ appId, messageId, text, key }); } };
  const store = new Store(path); const storageKey = randomBytes(32); const bridge = new Bridge(store, new SecretBox(storageKey), transport, sender, () => now);
  const alice = { id: 'oauth:alice', expiresAt: now + 3600000 }, bob = { id: 'oauth:bob', expiresAt: now + 3600000 };
  const message = (overrides: Partial<Inbound> = {}): Inbound => ({ appId: mockApp.appId, tenantKey: mockApp.tenantKey, openId: 'ou_alice', messageId: 'om_message', chatId: 'oc_alice', text: '你好 dot', timestamp: new Date(now).toISOString(), ...overrides });
  function bind(owner = alice, overrides: Partial<Inbound> = {}) { const { command } = bridge.beginBinding(owner); bridge.receive(message({ text: command, messageId: `om_bind_${randomBytes(4).toString('hex')}`, ...overrides })); return store.binding(owner.id)!; }
  async function subscribe(owner = alice) { const b = store.binding(owner.id)!; return bridge.subscribe(owner, { name: 'feishu.message.created', arguments: { binding_id: b.id }, delivery: { mode: 'webhook', url: `https://callback.example/dot/${owner.id}`, secret }, cursor: null }); }
  return { store, bridge, secret, calls, sent, alice, bob, bind, subscribe, message, transport, sender, storageKey, now: () => now, advance: (ms: number) => { now += ms; } };
}
export function encryptedCallback(payload: unknown, app = mockApp, at = Date.now()) {
  const iv = randomBytes(16), cipher = createCipheriv('aes-256-cbc', createHash('sha256').update(app.encryptKey).digest(), iv);
  const raw = JSON.stringify({ encrypt: Buffer.concat([iv, cipher.update(JSON.stringify(payload)), cipher.final()]).toString('base64') });
  const timestamp = String(Math.floor(at / 1000)), nonce = randomBytes(12).toString('hex');
  const headers = { 'content-type': 'application/json', 'x-lark-request-timestamp': timestamp, 'x-lark-request-nonce': nonce, 'x-lark-signature': createHash('sha256').update(timestamp + nonce + app.encryptKey + raw).digest('hex') };
  return { raw, headers };
}
export function feishuPayload(text = '你好', extras: { sender?: string; chatType?: string; appId?: string; tenant?: string; messageId?: string; type?: string } = {}) {
  return { schema: '2.0', header: { app_id: extras.appId ?? mockApp.appId, tenant_key: extras.tenant ?? mockApp.tenantKey, token: mockApp.verificationToken, event_type: 'im.message.receive_v1' }, event: { sender: { sender_type: extras.sender ?? 'user', tenant_key: extras.tenant ?? mockApp.tenantKey, sender_id: { open_id: 'ou_alice' } }, message: { message_id: extras.messageId ?? 'om_http', chat_id: 'oc_alice', chat_type: extras.chatType ?? 'p2p', message_type: extras.type ?? 'text', create_time: String(Date.now()), content: JSON.stringify({ text }) } } };
}
export function verifyDelivery(secret: string, call: { body: unknown; headers: Record<string, string> }) { return new Webhook(secret).verify(JSON.stringify(call.body), call.headers); }
