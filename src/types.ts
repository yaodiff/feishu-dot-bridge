import type { MediaReference, MediaParseFailure } from './media-policy.js';
export interface Principal { id: string; expiresAt: number }
export interface FeishuApp { appId: string; appSecret: string; tenantKey: string; encryptKey: string; verificationToken: string; domain: 'feishu' | 'lark'; ingress?: 'webhook' | 'websocket'; websocketExclusiveConsumer?: boolean }
export interface Identity { appId: string; tenantKey: string; openId: string }
export type ContentStatus = 'credential_blocked' | 'unsupported';
export interface Inbound extends Identity { messageId: string; chatId: string; text: string; timestamp: string; contentStatus?: ContentStatus; richPost?: true; mediaCandidate?: MediaReference; postImages?: readonly MediaReference[]; mediaCandidateStatus?: MediaParseFailure }
export interface Binding extends Identity { id: string; owner: string; active: number; chatId: string }
export interface Subscription { id: string; owner: string; bindingId: string; url: string; secret: string; oldSecret: string | null; rotateUntil: number; expiresAt: number; active: number }
export interface Inbox extends Inbound { id: string; owner: string; bindingId: string; seq: number }
export interface Job { seq: number; id: string; kind: 'event' | 'reply' | 'media_notice'; lane: string; inboxId: string; subscriptionId: string | null; payload: string; attempts: number; state: string; nextAt: number; firstAttemptAt: number | null; accessUntil: number; remoteMessageId: string | null; rootMessageId: string | null; parentMessageId: string | null; threadId: string | null; completedAt: number | null }
export interface DeliveryResponse { status: number; body: string }
export interface CallbackTransport { post(url: string, body: string, headers: Record<string, string>): Promise<DeliveryResponse>; close?(): void }
export interface MirrorJob { seq: number; id: string; owner: string; bindingId: string; appId: string; tenantKey: string; openId: string; chatId: string; sourceId: string; sourceRole: 'user' | 'assistant'; contentStatus: ContentStatus | null; payload: string; state: string; attempts: number; nextAt: number; firstAttemptAt: number | null; accessUntil: number; remoteMessageId: string | null }
export interface FeishuReplyReceipt { messageId?: string; rootId?: string; parentId?: string; threadId?: string }
export interface FeishuSender { sendBound?(appId: string, chatId: string, text: string, idempotencyKey: string): Promise<string>; reply(appId: string, messageId: string, text: string, idempotencyKey: string): Promise<FeishuReplyReceipt | void> }
export class BridgeError extends Error { constructor(public code: string, public status = 400) { super(code); this.name = 'BridgeError'; } }
