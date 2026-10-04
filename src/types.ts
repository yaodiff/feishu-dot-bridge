export interface Principal { id: string; expiresAt: number }
export interface FeishuApp { appId: string; appSecret: string; tenantKey: string; encryptKey: string; verificationToken: string; domain: 'feishu' | 'lark'; ingress?: 'webhook' | 'websocket'; websocketExclusiveConsumer?: boolean }
export interface Identity { appId: string; tenantKey: string; openId: string }
export interface Inbound extends Identity { messageId: string; chatId: string; text: string; timestamp: string }
export interface Binding extends Identity { id: string; owner: string; active: number; chatId: string }
export interface Subscription { id: string; owner: string; bindingId: string; url: string; secret: string; oldSecret: string | null; rotateUntil: number; expiresAt: number; active: number }
export interface Inbox extends Inbound { id: string; owner: string; bindingId: string; seq: number }
export interface Job { seq: number; id: string; kind: 'event' | 'reply'; lane: string; inboxId: string; subscriptionId: string | null; payload: string; attempts: number; state: string; nextAt: number; firstAttemptAt: number | null; accessUntil: number }
export interface DeliveryResponse { status: number; body: string }
export interface CallbackTransport { post(url: string, body: string, headers: Record<string, string>): Promise<DeliveryResponse> }
export interface FeishuSender { reply(appId: string, messageId: string, text: string, idempotencyKey: string): Promise<void> }
/** Optional future seam; the MVP rejects non-text messages and never invokes this. */
export interface AudioAdapter { transcribe(data: Uint8Array, mimeType: string): Promise<string>; synthesize?(text: string): Promise<{ data: Uint8Array; mimeType: string }> }
export class BridgeError extends Error { constructor(public code: string, public status = 400) { super(code); this.name = 'BridgeError'; } }
