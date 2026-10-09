/** Opt-in owner-bound media intake. Resource references stay volatile; no blob files or uploads. */
import { z } from 'zod';
import { Bridge } from './bridge.js';
import { hash } from './crypto.js';
import { classifyText } from './content-safety.js';
import { BridgeError, type Inbound, type Principal, type Inbox } from './types.js';
import { MEDIA_LIMITS, inspectMedia, validateReference, mediaNoticeSchema, type MediaNotice, type MediaKind, type MediaReference } from './media-policy.js';
import type { MediaTransport } from './feishu-media-transport.js';
import { POST_LIMITS } from './feishu-post.js';
import { sanitizeImage } from './media-image.js';

const readSchema = z.object({ event_id: z.string().min(1).max(256) }).strict();
export const imageReadSchema = readSchema.extend({ image_index: z.number().int().min(1).max(POST_LIMITS.images).default(1) }).strict();
export type MediaContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export type MediaResult = { isError?: boolean; content: MediaContent[] };
interface Entry {
  source: Readonly<Pick<Inbox, 'owner' | 'bindingId' | 'appId' | 'tenantKey' | 'openId' | 'chatId' | 'messageId'>>;
  reference: MediaReference; imageReferences?: readonly MediaReference[]; expiresAt: number;
}
const fields = ['owner', 'bindingId', 'appId', 'tenantKey', 'openId', 'chatId', 'messageId'] as const;
const exposedErrors = new Set(['media_processing_not_authorized', 'media_busy', 'media_cancelled', 'media_permission_denied',
  'media_download_failed', 'media_size_exceeded', 'media_mime_missing', 'media_mime_mismatch', 'media_encoding_rejected',
  'media_truncated', 'invalid_media_content', 'image_dimensions_exceeded', 'unsupported_image_format', 'media_transport_closed', 'image_decode_timeout', 'image_decoder_unavailable']);
const status = (eventId: string, state: string, kind?: MediaKind): MediaResult => ({ isError: state !== 'image_ready',
  content: [{ type: 'text', text: JSON.stringify({ event_id: eventId, source: 'feishu', state, ...(kind ? { kind } : {}), untrusted_content: true }) }] });

export class MediaInputCandidate {
  private readonly entries = new Map<string, Entry>();
  private readonly active = new Map<string, AbortController>();
  private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private closed = false;
  private readonly activatedAt: number;
  constructor(private readonly bridge: Bridge, private readonly transport: MediaTransport,
    private readonly isProcessingApproved: (principal: Principal, eventId: string, kind: MediaKind) => boolean = () => false,
    private readonly now: () => number = Date.now) { this.activatedAt = this.now(); }

  /** Trusted ingress ONLY: pass the exact result of authenticated decodeFeishu(...,
   * true) or decodeFeishuWebSocket(..., true). Never expose this as a public tool.
   * The normal bridge first checks pairing, sender, chat, app, tenant and dedupe. */
  receiveAuthenticated(message: Inbound): { state: string; media_state?: string } {
    if (this.closed) throw new BridgeError('media_transport_closed');
    this.expireReferences();
    let reference: MediaReference | undefined, imageReferences: readonly MediaReference[] | undefined, notice: MediaNotice | undefined, expiresAt = 0;
    const blocked = message.contentStatus === 'credential_blocked' || classifyText(message.text) === 'credential';
    if (!blocked && message.postImages) {
      if (!message.postImages.length || message.postImages.length > POST_LIMITS.images || message.mediaCandidate) throw new BridgeError('invalid_media_reference');
      imageReferences = Object.freeze(message.postImages.map(item => { const ref = validateReference(item); if (ref.kind !== 'image') throw new BridgeError('invalid_media_reference'); return ref; }));
    }
    if (blocked) { /* No resource reference survives the whole-message credential gate. */ }
    else if (message.mediaCandidateStatus) notice = { source: 'feishu', state: message.mediaCandidateStatus, at_receipt: true };
    else if (message.mediaCandidate || imageReferences) {
      reference = imageReferences?.[0] ?? validateReference(message.mediaCandidate!);
      const timestamp = Date.parse(message.timestamp);
      if (Number.isFinite(timestamp) && timestamp < this.activatedAt) notice = { source: 'feishu', state: 'media_before_activation', at_receipt: true };
      else if ([...this.entries.values()].reduce((count, entry) => count + (entry.imageReferences?.length ?? 1), 0) + (imageReferences?.length ?? 1) > MEDIA_LIMITS.maxReferences) notice = { source: 'feishu', state: 'media_capacity_exceeded', at_receipt: true };
      else if (!Number.isFinite(timestamp) || timestamp > this.now() + 60000 || timestamp + MEDIA_LIMITS.referenceTtlMs <= this.now()) notice = { source: 'feishu', state: 'media_expired', at_receipt: true };
      else {
        expiresAt = Math.min(this.now() + MEDIA_LIMITS.referenceTtlMs, timestamp + MEDIA_LIMITS.referenceTtlMs);
        notice = { source: 'feishu', kind: reference.kind, state: 'media_available', ...(imageReferences ? { image_count: imageReferences.length } : {}), expires_at: new Date(expiresAt).toISOString(), at_receipt: true };
      }
    }
    // Inbox, dedupe receipt and safe callback notice commit in the SAME transaction.
    // A persistence failure rolls everything back so upstream retry can repair it.
    const received = this.bridge.receive(message, notice);
    if (received.state !== 'accepted') return received;
    if (!reference || !expiresAt) return { ...received, ...(notice ? { media_state: notice.state } : {}) };
    const eventId = `evt_${hash(JSON.stringify([message.appId, message.tenantKey, message.messageId]))}`;
    const inbox = this.bridge.store.inbox(eventId)!;
    this.entries.set(eventId, { source: Object.freeze(Object.fromEntries(fields.map(field => [field, inbox[field]])) as Entry['source']), reference, ...(imageReferences ? { imageReferences } : {}), expiresAt });
    const timer = setTimeout(() => this.forgetReference(eventId), Math.max(0, expiresAt - this.now()));
    timer.unref(); this.expiryTimers.set(eventId, timer);
    return { ...received, media_state: notice!.state };
  }
  /** Metadata only; never fetches. Current event authorization runs first.
   * Persisted callback notices are recovered without recovering a resource key. */
  describe(principal: Principal, eventId: string): MediaNotice | undefined {
    const event = this.bridge.getEvent(principal, { event_id: eventId });
    const fallback = (): MediaNotice | undefined => event.content_status === 'unsupported' ? { source: 'feishu', state: 'media_not_available' } : undefined;
    const entry = this.entries.get(eventId);
    const inbox = entry && this.bridge.store.inbox(eventId);
    if (entry && (!inbox || fields.some(field => inbox[field] !== entry.source[field]))) return { source: 'feishu', kind: entry.reference.kind, ...(entry.imageReferences ? { image_count: entry.imageReferences.length } : {}), state: 'media_error' };
    if (entry && entry.expiresAt > this.now()) return { kind: entry.reference.kind, state: 'media_available', source: 'feishu', ...(entry.imageReferences ? { image_count: entry.imageReferences.length } : {}), expires_at: new Date(entry.expiresAt).toISOString() };
    const row = this.bridge.store.db.prepare("SELECT payload FROM jobs WHERE inboxId=? AND kind IN ('event','media_notice') ORDER BY seq LIMIT 1").get(eventId);
    try {
      const parsed = mediaNoticeSchema.safeParse(row ? JSON.parse(String(row.payload)).data?.media : undefined);
      if (!parsed.success) return fallback();
      const { at_receipt: _snapshot, ...notice } = parsed.data;
      if (notice.state === 'media_available') return { ...notice, state: notice.expires_at && Date.parse(notice.expires_at) <= this.now() ? 'media_expired' : 'media_unavailable_after_restart' };
      return notice;
    } catch { return fallback(); }
  }
  async readImage(principal: Principal, input: unknown, callerSignal?: AbortSignal): Promise<MediaResult> {
    this.bridge.listPendingEvents(principal, { limit: 1 });
    const { event_id: id, image_index: index } = imageReadSchema.parse(input), entry = this.authorize(principal, id);
    if (index > (entry.imageReferences?.length ?? 1)) throw new BridgeError('media_not_available', 403);
    return this.readSelected(principal, id, callerSignal, index - 1);
  }
  private authorize(principal: Principal, eventId: string, expected?: Entry): Entry {
    // Same full owner/current-binding/revocation/recent-window authorization as text reads.
    this.bridge.getEvent(principal, { event_id: eventId });
    const entry = this.entries.get(eventId), inbox = this.bridge.store.inbox(eventId);
    if (!entry || !inbox || entry.expiresAt <= this.now() || (expected && entry !== expected) || fields.some(field => inbox[field] !== entry.source[field])) throw new BridgeError('media_not_available', 403);
    if (!this.isProcessingApproved(principal, eventId, entry.reference.kind)) throw new BridgeError('media_processing_not_authorized', 403);
    return entry;
  }
  /** event_id only: no key, URL, host, local path, provider, or recipient argument. */
  async read(principal: Principal, input: unknown, callerSignal?: AbortSignal): Promise<MediaResult> {
    // Authenticate before parsing arguments to preserve existing read semantics.
    this.bridge.listPendingEvents(principal, { limit: 1 });
    if (this.closed) throw new BridgeError('media_transport_closed');
    const { event_id: eventId } = readSchema.parse(input);
    return this.readSelected(principal, eventId, callerSignal);
  }
  private async readSelected(principal: Principal, eventId: string, callerSignal?: AbortSignal, imageIndex = 0): Promise<MediaResult> {
    if (this.closed) throw new BridgeError('media_transport_closed');
    const entry = this.authorize(principal, eventId), reference = entry.imageReferences?.[imageIndex] ?? entry.reference, kind = reference.kind;
    if (this.active.has(eventId) || this.active.size >= MEDIA_LIMITS.maxConcurrent) return status(eventId, 'media_busy', kind);
    const controller = new AbortController(); this.active.set(eventId, controller);
    const callerAbort = () => controller.abort(); callerSignal?.addEventListener('abort', callerAbort, { once: true });
    if (callerSignal?.aborted) controller.abort();
    const timer = setTimeout(() => controller.abort(), MEDIA_LIMITS.requestMs);
    let bytes: Buffer | undefined;
    try {
      const check = () => { this.authorize(principal, eventId, entry); if (controller.signal.aborted) throw new BridgeError('media_cancelled'); };
      check();
      const downloaded = await this.transport.download({ appId: entry.source.appId, messageId: entry.source.messageId, reference }, controller.signal, check);
      bytes = downloaded.bytes; check();
      const inspected = inspectMedia(bytes, kind, downloaded.declaredMime);
      const sanitized = await sanitizeImage(bytes, inspected.mimeType, controller.signal);
      try {
        check();
        return { content: [{ type: 'text', text: JSON.stringify({ event_id: eventId, source: 'feishu', state: 'image_ready', kind, untrusted_content: true,
          image_sanitized: true, ...(entry.imageReferences ? { image_index: imageIndex + 1, image_count: entry.imageReferences.length } : {}), width: sanitized.width, height: sanitized.height, original_width: sanitized.originalWidth, original_height: sanitized.originalHeight }) },
          { type: 'image', data: sanitized.bytes.toString('base64'), mimeType: sanitized.mimeType }] };
      } finally { sanitized.bytes.fill(0); }
    } catch (error) {
      const code = error instanceof BridgeError && exposedErrors.has(error.code) ? error.code : 'media_download_failed';
      // Check after every asynchronous boundary: unlink/rebind/revoke hides results.
      this.authorize(principal, eventId, entry);
      return status(eventId, code, kind);
    } finally { bytes?.fill(0); clearTimeout(timer); callerSignal?.removeEventListener('abort', callerAbort); this.active.delete(eventId); }
  }
  /** In-memory reference eviction only. No filesystem/database purge. */
  private forgetReference(id: string): void {
    this.active.get(id)?.abort(); this.entries.delete(id);
    clearTimeout(this.expiryTimers.get(id)); this.expiryTimers.delete(id);
  }
  expireReferences(): void { for (const [id, entry] of this.entries) if (entry.expiresAt <= this.now()) this.forgetReference(id); }
  close(): void { this.closed = true; for (const active of this.active.values()) active.abort(); for (const id of this.entries.keys()) this.forgetReference(id); }
}
