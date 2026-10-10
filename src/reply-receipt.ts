import type { FeishuReplyReceipt } from './types.js';

/** Only provider message/thread identifiers are receipt metadata. No raw response,
 * content, routing identity, authorization headers or arbitrary strings survive. */
export function sanitizeReplyReceipt(value: unknown): FeishuReplyReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const id = (value: unknown, prefix: 'om_' | 'omt_') =>
    typeof value === 'string' && value.length <= 256 && new RegExp('^' + prefix + '[A-Za-z0-9_-]+$').test(value) ? value : undefined;
  const messageId = id(raw.messageId, 'om_'), rootId = id(raw.rootId, 'om_');
  const parentId = id(raw.parentId, 'om_'), threadId = id(raw.threadId, 'omt_');
  return { ...(messageId ? { messageId } : {}), ...(rootId ? { rootId } : {}),
    ...(parentId ? { parentId } : {}), ...(threadId ? { threadId } : {}) };
}
