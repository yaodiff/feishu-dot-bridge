import { classifyText } from './content-safety.js';
import { mediaNoticeSchema, type MediaNotice } from './media-policy.js';
import { Webhook } from 'standardwebhooks';
import { z } from 'zod';
import { hash, equal, randomToken, SecretBox } from './crypto.js';
import { Store, type OwnedEventRow } from './store.js';
import { BridgeError, type Principal, type Inbound, type Subscription, type CallbackTransport, type FeishuSender, type Binding, type Job, type MirrorJob, type ContentStatus } from './types.js';
export const EVENT_NAME = 'feishu.message.created';
export type CallbackVerificationReason = 'request_failed' | 'over_budget' | 'http_status' | 'invalid_json' | 'challenge_missing' | 'challenge_mismatch' | 'verified';
export interface CallbackVerificationDiagnostic { event: 'callback_verification'; reason: CallbackVerificationReason; elapsedMs: number; httpStatus?: number }
export const subscriptionArgs = z.object({ binding_id: z.string().min(1).max(256) }).strict();
const deliverySchema = z.object({ mode: z.literal('webhook'), url: z.string().url().max(4096), secret: z.string().max(256) }).strict();
export const subscribeSchema = z.object({ name: z.literal(EVENT_NAME), arguments: subscriptionArgs, delivery: deliverySchema, cursor: z.null().optional(), ttlMs: z.number().int().positive().nullable().optional(), _meta: z.record(z.string(), z.unknown()).optional() }).strict();
export const unsubscribeSchema = z.object({ name: z.literal(EVENT_NAME), arguments: subscriptionArgs, delivery: deliverySchema.omit({ secret: true }), _meta: z.record(z.string(), z.unknown()).optional() }).strict();
export const listPendingEventsSchema = z.object({ limit: z.number().int().min(1).max(20).default(10), cursor: z.string().min(1).max(1024).optional() }).strict();
export const getEventSchema = z.object({ event_id: z.string().min(1).max(256) }).strict();
const eventWindowMs = 24 * 3600000, cursorLifetimeMs = 15 * 60000;
const pendingCursorSchema = z.object({ type: z.literal('pending-events-v1'), scope: z.string().regex(/^[a-f0-9]{64}$/), after: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), through: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), expires: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
export const OMITTED_CREDENTIAL_TEXT = '[未同步：消息可能包含登录凭据或其他密钥]';
export const UNSUPPORTED_CONTENT_TEXT = '[未同步：暂不支持此消息类型]';
function safeContent(text: string, status?: ContentStatus | null) {
  const contentStatus = status === 'unsupported' ? status : status === 'credential_blocked' || classifyText(text) === 'credential' ? 'credential_blocked' : undefined;
  return { text: contentStatus === 'unsupported' ? UNSUPPORTED_CONTENT_TEXT : contentStatus === 'credential_blocked' ? OMITTED_CREDENTIAL_TEXT : text, ...(contentStatus ? { content_status: contentStatus } : {}) };
}
const eventPayload = (row: OwnedEventRow) => ({ event_id: row.event_id, ...safeContent(row.text, row.content_status), timestamp: row.timestamp });
export const sendBoundSchema = z.object({ binding_id: z.string().min(1).max(256), source_message_id: z.string().min(1).max(256), source_role: z.enum(['user', 'assistant']), text: z.string().min(1).max(12000) }).strict();
export const mirrorStatusSchema = z.object({ sync_id: z.string().min(1).max(256) }).strict();
const safeReplyStates = new Set(['pending', 'sending', 'sent', 'dead', 'cancelled', 'uncertain', 'blocked']);
export const replySchema = z.object({ event_id: z.string().min(1).max(256), text: z.string().min(1).max(12000) }).strict();
export function validSecret(secret: string): boolean { if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) return false; const b = Buffer.from(secret.slice(6), 'base64'); return b.length >= 24 && b.length <= 64 && b.toString('base64').replace(/=+$/, '') === secret.slice(6).replace(/=+$/, ''); }
export class Bridge {
  private pumping = false;
  private preferMirror = false;
  constructor(readonly store: Store, private box: SecretBox, private transport: CallbackTransport, private sender: FeishuSender, private now: () => number = Date.now, private personal?: { owner: string; appId: string; tenantKey: string }, private diagnostic?: (event: CallbackVerificationDiagnostic) => void | Promise<void>) { if (personal) store.assertPersonalScope(personal.owner, personal.appId, personal.tenantKey); }
  private verificationDiagnostic(reason: CallbackVerificationReason, started: number, httpStatus?: number): void {
    const elapsedMs = Math.max(0, Math.min(60000, Math.floor(this.now() - started)));
    if (!Number.isFinite(elapsedMs)) return;
    const event: CallbackVerificationDiagnostic = { event: 'callback_verification', reason, elapsedMs };
    if (Number.isInteger(httpStatus) && httpStatus! >= 100 && httpStatus! <= 599) event.httpStatus = httpStatus;
    try { void Promise.resolve(this.diagnostic?.(Object.freeze(event))).catch(() => {}); } catch { /* Observation must not change verification. */ }
  }
  private authorize(p: Principal) { if ((this.personal && p.id !== this.personal.owner) || p.expiresAt <= this.now() || this.store.isRevoked(p.id)) throw new BridgeError('unauthorized', 401); }
  beginBinding(p: Principal) { this.authorize(p); if (this.store.binding(p.id)) throw new BridgeError('already_bound_unlink_first'); const code = randomToken(); const expiresAt = Math.min(this.now() + 300000, p.expiresAt); this.store.transaction(() => { this.store.db.prepare('DELETE FROM pairs WHERE owner=? OR expiresAt<=?').run(p.id, this.now()); this.store.db.prepare('INSERT INTO pairs VALUES (?,?,?)').run(hash(code), p.id, expiresAt); }); return { command: `/bind ${code}`, expires_at: new Date(expiresAt).toISOString(), instruction: 'Send this command only in a private chat with the intended Feishu bot. Then check binding_status. Never share this code.' }; }
  status(p: Principal) { this.authorize(p); const b = this.store.binding(p.id); return b ? { bound: true, binding_id: b.id, app_id: b.appId, tenant_key: b.tenantKey, open_id: b.openId } : { bound: false }; }
  unlink(p: Principal) { this.authorize(p); this.store.transaction(() => { this.store.db.prepare('UPDATE bindings SET active=0 WHERE owner=?').run(p.id); this.store.db.prepare('UPDATE subscriptions SET active=0 WHERE owner=?').run(p.id); this.store.db.prepare('DELETE FROM pairs WHERE owner=?').run(p.id); this.store.db.prepare("UPDATE mirror_outbox SET state='cancelled' WHERE owner=? AND state='pending'").run(p.id); this.store.db.prepare("UPDATE jobs SET state='cancelled' WHERE inboxId IN (SELECT id FROM inbox WHERE owner=?) AND state='pending'").run(p.id); }); return { unlinked: true }; }
  receive(m: Inbound, mediaNotice?: MediaNotice): { state: string } {
    const media = mediaNotice === undefined ? undefined : mediaNoticeSchema.parse(mediaNotice);
    if (this.personal && (m.appId !== this.personal.appId || m.tenantKey !== this.personal.tenantKey)) return { state: 'wrong_installation' };
    return this.store.transaction(() => {
      const receiptId = hash(JSON.stringify([m.appId, m.tenantKey, m.messageId]));
      if (this.store.db.prepare('SELECT id FROM receipts WHERE id=?').get(receiptId)) return { state: 'duplicate' };
      this.store.db.prepare('INSERT INTO receipts VALUES (?,?)').run(receiptId, this.now());
      if (!m.richPost && !m.contentStatus && m.text.startsWith('/bind')) {
        const code = /^\/bind ([A-Za-z0-9_-]{32})$/.exec(m.text)?.[1];
        const pair = code ? this.store.db.prepare('SELECT * FROM pairs WHERE digest=? AND expiresAt>?').get(hash(code), this.now()) as { owner: string } | undefined : undefined;
        if (!pair || this.store.isRevoked(pair.owner)) return { state: 'binding_rejected' };
        // Never steal/reassign an existing identity or silently replace the owner's binding.
        const existing = this.store.db.prepare('SELECT id FROM bindings WHERE active=1 AND (owner=? OR (appId=? AND tenantKey=? AND openId=?))').get(pair.owner, m.appId, m.tenantKey, m.openId);
        if (existing) return { state: 'binding_rejected' };
        this.store.db.prepare('INSERT INTO bindings(id,owner,appId,tenantKey,openId,chatId) VALUES (?,?,?,?,?,?)').run(`bind_${randomToken()}`, pair.owner, m.appId, m.tenantKey, m.openId, m.chatId);
        this.store.db.prepare('DELETE FROM pairs WHERE digest=?').run(hash(code!));
        return { state: 'bound' };
      }
      const binding = this.store.db.prepare('SELECT * FROM bindings WHERE active=1 AND appId=? AND tenantKey=? AND openId=? AND chatId=?').get(m.appId, m.tenantKey, m.openId, m.chatId) as Binding | undefined;
      if (!binding || this.store.isRevoked(binding.owner)) return { state: 'unbound' };
      const content = safeContent(m.text, m.contentStatus);
      const eventId = `evt_${receiptId}`;
      this.store.db.prepare('INSERT INTO inbox(id,owner,bindingId,appId,tenantKey,openId,messageId,chatId,text,timestamp) VALUES (?,?,?,?,?,?,?,?,?,?)').run(eventId, binding.owner, binding.id, m.appId, m.tenantKey, m.openId, m.messageId, m.chatId, content.text, m.timestamp);
      if (content.content_status) this.store.db.prepare('INSERT INTO content_dispositions(eventId,status) VALUES (?,?)').run(eventId, content.content_status);
      const subscriptions = this.store.db.prepare('SELECT * FROM subscriptions WHERE bindingId=? AND active=1 AND expiresAt>?').all(binding.id, this.now()) as unknown as Subscription[];
      // A non-deliverable metadata row preserves polling-only post availability
      // without storing resource keys, changing schema, or synthesizing callbacks.
      if (!subscriptions.length && m.postImages?.length && media) this.store.db.prepare('INSERT INTO jobs(id,kind,lane,inboxId,payload,state) VALUES (?,?,?,?,?,?)')
        .run(`media_notice_${hash(eventId)}`, 'media_notice', `media_notice:${eventId}`, eventId, JSON.stringify({ data: { media } }), 'local');
      for (const sub of subscriptions) {
        const payload = JSON.stringify({ eventId, name: EVENT_NAME, timestamp: m.timestamp, data: { event_id: eventId, binding_id: binding.id, ...content, ...(media ? { media } : {}) }, cursor: null });
        this.store.db.prepare('INSERT INTO jobs(id,kind,lane,inboxId,subscriptionId,payload) VALUES (?,?,?,?,?,?)').run(`event_${hash(sub.id + eventId)}`, 'event', `event:${sub.id}`, eventId, sub.id, payload);
      }
      return { state: 'accepted' };
    });
  }
  private subId(owner: string, bindingId: string, url: string) { return `sub_${hash(JSON.stringify([owner, url, EVENT_NAME, { binding_id: bindingId }]))}`; }
  async subscribe(p: Principal, input: unknown) {
    this.authorize(p); const args = subscribeSchema.parse(input); const binding = this.store.binding(p.id);
    if (!binding || binding.id !== args.arguments.binding_id) throw new BridgeError('binding_not_found', 403);
    if (!validSecret(args.delivery.secret)) throw new BridgeError('invalid_signing_secret');
    const id = this.subId(p.id, binding.id, args.delivery.url), challenge = randomToken();
    const body = JSON.stringify({ type: 'verification', challenge });
    const started = this.now(); let response;
    try { response = await this.transport.post(args.delivery.url, body, this.signedHeaders(id, `verify_${randomToken()}`, body, args.delivery.secret)); } catch { this.verificationDiagnostic('request_failed', started); throw new BridgeError('callback_verification_failed'); }
    let echoed: unknown, parsed = true; try { echoed = JSON.parse(response.body)?.challenge; } catch { parsed = false; }
    const reason: CallbackVerificationReason = this.now() - started > 10000 ? 'over_budget' : response.status < 200 || response.status >= 300 ? 'http_status' : !parsed ? 'invalid_json' : typeof echoed !== 'string' ? 'challenge_missing' : !equal(challenge, echoed) ? 'challenge_mismatch' : 'verified';
    this.verificationDiagnostic(reason, started, response.status);
    if (reason !== 'verified') throw new BridgeError('callback_verification_failed');
    const expiresAt = Math.min(this.now() + Math.min(args.ttlMs ?? 3600000, 3600000), p.expiresAt);
    this.store.transaction(() => {
      this.authorize(p); if (!this.store.bindingById(binding.id)) throw new BridgeError('binding_not_found', 403);
      // MVP permits one dot subscription per binding; prevent accidental fan-out to different chats.
      const other = this.store.db.prepare('SELECT id FROM subscriptions WHERE bindingId=? AND id!=? AND active=1 AND expiresAt>?').get(binding.id, id, this.now());
      if (other) throw new BridgeError('subscription_exists_unsubscribe_first');
      const existing = this.store.subscription(id); const changed = existing && this.box.open(existing.secret) !== args.delivery.secret;
      const old = changed ? existing.secret : existing && existing.rotateUntil > this.now() ? existing.oldSecret : null;
      const rotateUntil = changed ? this.now() + 300000 : old ? existing!.rotateUntil : 0;
      this.store.db.prepare('INSERT INTO subscriptions(id,owner,bindingId,url,secret,oldSecret,rotateUntil,expiresAt) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET secret=excluded.secret,oldSecret=excluded.oldSecret,rotateUntil=excluded.rotateUntil,expiresAt=excluded.expiresAt,active=1').run(id, p.id, binding.id, args.delivery.url, this.box.seal(args.delivery.secret), old, rotateUntil, expiresAt);
    });
    return { id, refreshBefore: new Date(expiresAt).toISOString(), cursor: null, truncated: false };
  }
  unsubscribe(p: Principal, input: unknown) { this.authorize(p); const args = unsubscribeSchema.parse(input); const id = this.subId(p.id, args.arguments.binding_id, args.delivery.url); this.store.transaction(() => { this.store.db.prepare('UPDATE subscriptions SET active=0 WHERE id=? AND owner=?').run(id, p.id); this.store.db.prepare("UPDATE jobs SET state='cancelled' WHERE subscriptionId=? AND state='pending'").run(id); }); return {}; }
  reply(p: Principal, input: unknown) {
    this.authorize(p); const args = replySchema.parse(input);
    return this.store.transaction(() => {
      const inbox = this.store.inbox(args.event_id);
      if (!inbox || inbox.owner !== p.id || !this.store.bindingById(inbox.bindingId) || this.now() - Date.parse(inbox.timestamp) > 24 * 3600000) throw new BridgeError('event_not_found', 403);
      const content = safeContent(args.text);
      const id = `reply_${hash(args.event_id)}`, payload = JSON.stringify({ text: content.text }); const existing = this.store.job(id);
      if (existing) { if (existing.payload !== payload) throw new BridgeError('reply_already_reserved'); return { reply_id: id, state: existing.state, ...(content.content_status ? { content_status: content.content_status } : {}) }; }
      this.store.db.prepare('INSERT INTO jobs(id,kind,lane,inboxId,payload,accessUntil) VALUES (?,?,?,?,?,?)').run(id, 'reply', `reply:${inbox.bindingId}`, inbox.id, payload, p.expiresAt);
      return { reply_id: id, state: 'pending', ...(content.content_status ? { content_status: content.content_status } : {}) };
    });
  }
  sendToBoundFeishu(p: Principal, input: unknown) {
    this.authorize(p); const args = sendBoundSchema.parse(input);
    return this.store.transaction(() => {
      this.authorize(p); const binding = this.eventReadBinding(p);
      if (!binding || binding.id !== args.binding_id) throw new BridgeError('binding_not_found', 403);
      if (!this.sender.sendBound) throw new BridgeError('send_not_supported', 503);
      // Never accept caller-provided routing. Binding ID is a generation guard, not a destination.
      const content = safeContent(args.text);
      const payload = JSON.stringify({ text: `[来自 ChatGPT · ${args.source_role === 'user' ? '你' : 'dot'}]\n${content.text}` });
      const id = `sync_${hash(JSON.stringify([p.id, binding.id, args.source_message_id]))}`;
      const existing = this.store.mirrorJob(id);
      if (existing) {
        if (existing.payload !== payload || existing.sourceRole !== args.source_role) throw new BridgeError('source_already_reserved');
        return this.mirrorResult(existing);
      }
      this.store.db.prepare('INSERT INTO mirror_outbox(id,owner,bindingId,appId,tenantKey,openId,chatId,sourceId,sourceRole,contentStatus,payload,accessUntil) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, p.id, binding.id, binding.appId, binding.tenantKey, binding.openId, binding.chatId, args.source_message_id, args.source_role, content.content_status ?? null, payload, p.expiresAt);
      return this.mirrorResult(this.store.mirrorJob(id)!);
    });
  }
  private mirrorResult(job: MirrorJob) {
    return { sync_id: job.id, state: job.state, attempts: job.attempts, ...(job.contentStatus ? { content_status: job.contentStatus } : {}), ...(job.remoteMessageId ? { message_id: job.remoteMessageId } : {}) };
  }
  mirrorDeliveryStatus(p: Principal, input: unknown) {
    this.authorize(p); const args = mirrorStatusSchema.parse(input), binding = this.eventReadBinding(p), job = this.store.mirrorJob(args.sync_id);
    if (!job || !binding || !this.ownsMirror(job, binding) || job.owner !== p.id) throw new BridgeError('sync_not_found', 403);
    return this.mirrorResult(job);
  }
  private ownsMirror(job: MirrorJob, binding: Binding) {
    return job.owner === binding.owner && job.bindingId === binding.id && job.appId === binding.appId && job.tenantKey === binding.tenantKey && job.openId === binding.openId && job.chatId === binding.chatId;
  }
  private async pumpMirrorOne(): Promise<boolean> {
    const job = this.store.db.prepare(`SELECT * FROM mirror_outbox j WHERE j.state='pending' AND j.nextAt<=? AND NOT EXISTS (SELECT 1 FROM mirror_outbox p WHERE p.bindingId=j.bindingId AND p.seq<j.seq AND p.state IN ('pending','sending')) ORDER BY j.seq LIMIT 1`).get(this.now()) as MirrorJob | undefined;
    if (!job) return false;
    const binding = this.store.bindingById(job.bindingId);
    const set = (state: string) => this.store.db.prepare('UPDATE mirror_outbox SET state=? WHERE id=?').run(state, job.id);
    if (!binding || !this.ownsMirror(job, binding) || this.store.isRevoked(job.owner) || (this.personal && (job.owner !== this.personal.owner || job.appId !== this.personal.appId || job.tenantKey !== this.personal.tenantKey))) { set('cancelled'); return true; }
    if (job.accessUntil <= this.now() || (job.firstAttemptAt !== null && this.now() - job.firstAttemptAt >= 55 * 60000)) { set(job.firstAttemptAt === null ? 'cancelled' : 'uncertain'); return true; }
    let text: string;
    try { text = z.object({ text: z.string().min(1).max(12100) }).strict().parse(JSON.parse(job.payload)).text; }
    catch { set('blocked'); return true; }
    // Fail closed if a legacy/tampered stored body is suspect. Never replace an attempted payload under its UUID.
    if (classifyText(text) === 'credential' || !this.sender.sendBound) { set('blocked'); return true; }
    this.store.db.prepare("UPDATE mirror_outbox SET state='sending',attempts=attempts+1,firstAttemptAt=COALESCE(firstAttemptAt,?) WHERE id=?").run(this.now(), job.id);
    try {
      const remoteId = await this.sender.sendBound(job.appId, job.chatId, text, hash(job.id).slice(0, 32));
      if (!remoteId || remoteId.length > 256) throw new Error('invalid_remote_id');
      this.store.db.prepare("UPDATE mirror_outbox SET state='sent',remoteMessageId=? WHERE id=?").run(remoteId, job.id);
    } catch {
      const attempts = job.attempts + 1;
      if (attempts >= 8) set('uncertain');
      else this.store.db.prepare("UPDATE mirror_outbox SET state='pending',nextAt=? WHERE id=?").run(this.now() + Math.min(300000, 1000 * 2 ** (attempts - 1)), job.id);
    }
    return true;
  }
  deliveryStatus(p: Principal, eventId: string) { this.authorize(p); const inbox = this.store.inbox(eventId); if (!inbox || inbox.owner !== p.id || !this.store.bindingById(inbox.bindingId)) throw new BridgeError('event_not_found', 403); const job = this.store.job(`reply_${hash(eventId)}`); return { event_id: eventId, state: job?.state ?? 'not_queued', attempts: job?.attempts ?? 0 }; }
  private eventReadBinding(p: Principal): Binding | undefined {
    const binding = this.store.binding(p.id);
    if (this.personal && binding && (binding.appId !== this.personal.appId || binding.tenantKey !== this.personal.tenantKey)) return undefined;
    return binding;
  }
  listPendingEvents(p: Principal, input: unknown = {}) {
    // Cursor possession never grants access: authenticate before parsing it or reading inbox data.
    this.authorize(p);
    const args = listPendingEventsSchema.parse(input), now = this.now(), binding = this.eventReadBinding(p);
    const scope = binding && hash(JSON.stringify([binding.owner, binding.id, binding.appId, binding.tenantKey, binding.openId, binding.chatId]));
    let after = 0, through = 0, at = now, expires = Math.min(now + cursorLifetimeMs, p.expiresAt);
    if (args.cursor !== undefined) {
      try {
        if (!/^[A-Za-z0-9_-]+$/.test(args.cursor)) throw new Error();
        const bytes = Buffer.from(args.cursor, 'base64url');
        if (bytes.toString('base64url') !== args.cursor) throw new Error();
        const c = pendingCursorSchema.parse(JSON.parse(this.box.open(bytes.toString('base64'))));
        if (!binding || c.scope !== scope || c.after > c.through || c.at > now || c.expires <= now || c.expires <= c.at || c.expires > c.at + cursorLifetimeMs) throw new Error();
        ({ after, through, at, expires } = c);
        // A shorter renewed authorization lease can only shorten the next cursor.
        expires = Math.min(expires, p.expiresAt);
      } catch { throw new BridgeError('invalid_cursor'); }
    } else if (binding) through = this.store.ownedEventHighWater(binding);
    if (!binding) return { events: [], next_cursor: null };
    // The snapshot bounds arrival order; eligibility and pending status remain live.
    const rows = this.store.pendingOwnedEvents(binding, now - eventWindowMs, at, after, through, args.limit + 1);
    const page = rows.slice(0, args.limit), last = page.at(-1);
    const next = rows.length > args.limit && last ? Buffer.from(this.box.seal(JSON.stringify({ type: 'pending-events-v1', scope, after: last.seq, through, at, expires })), 'base64').toString('base64url') : null;
    return { events: page.map(eventPayload), next_cursor: next };
  }
  getEvent(p: Principal, input: unknown) {
    this.authorize(p);
    const args = getEventSchema.parse(input), now = this.now(), binding = this.eventReadBinding(p);
    const row = binding && this.store.ownedRecentEvent(binding, args.event_id, now - eventWindowMs, now);
    if (!row) throw new BridgeError('event_not_found', 403);
    const state = row.state === null ? 'not_queued' : safeReplyStates.has(row.state) ? row.state : 'unknown';
    const attempts = Number.isSafeInteger(row.attempts) && row.attempts! >= 0 ? row.attempts! : 0;
    return { ...eventPayload(row), reply: { state, attempts } };
  }
  private signedHeaders(subscriptionId: string, eventId: string, body: string, secret: string, oldSecret?: string): Record<string, string> {
    const date = new Date(this.now()); let signature = new Webhook(secret).sign(eventId, date, body);
    if (oldSecret) signature += ` ${new Webhook(oldSecret).sign(eventId, date, body)}`;
    return { 'content-type': 'application/json', 'webhook-id': eventId, 'webhook-timestamp': String(Math.floor(date.getTime() / 1000)), 'webhook-signature': signature, 'x-mcp-subscription-id': subscriptionId };
  }
  async waitForIdle(): Promise<void> { while (this.pumping) await new Promise(resolve => setTimeout(resolve, 25)); }
  async pump(limit = 100): Promise<number> {
    if (this.pumping) return 0; this.pumping = true; let processed = 0;
    try {
      while (processed < limit) {
        // Alternate available lanes so continuous callbacks cannot starve bound sends.
        if (this.preferMirror && await this.pumpMirrorOne()) { processed++; this.preferMirror = false; continue; }
        // Earlier pending jobs block later jobs in their lane, even during backoff.
        const job = this.store.db.prepare(`SELECT * FROM jobs j WHERE j.kind IN ('event','reply') AND j.state='pending' AND j.nextAt<=? AND NOT EXISTS (SELECT 1 FROM jobs p WHERE p.lane=j.lane AND p.seq<j.seq AND p.state IN ('pending','sending')) ORDER BY j.seq LIMIT 1`).get(this.now()) as Job | undefined;
        if (!job) { if (await this.pumpMirrorOne()) { processed++; this.preferMirror = false; continue; } break; } processed++; this.preferMirror = true;
        const inbox = this.store.inbox(job.inboxId), binding = inbox && this.store.bindingById(inbox.bindingId);
        const sub = job.subscriptionId ? this.store.subscription(job.subscriptionId) : undefined;
        if (!inbox || !binding || (this.personal && (inbox.owner !== this.personal.owner || inbox.appId !== this.personal.appId || inbox.tenantKey !== this.personal.tenantKey)) || this.store.isRevoked(inbox.owner) || (job.kind === 'event' && (!sub || !sub.active || sub.expiresAt <= this.now() || sub.bindingId !== binding.id))) { this.setState(job, 'cancelled'); continue; }
        if (job.kind === 'reply' && ((job.firstAttemptAt !== null && this.now() - job.firstAttemptAt >= 55 * 60000) || job.accessUntil <= this.now())) { this.setState(job, job.firstAttemptAt === null ? 'cancelled' : 'uncertain'); continue; }
        this.store.db.prepare("UPDATE jobs SET state='sending',attempts=attempts+1,firstAttemptAt=COALESCE(firstAttemptAt,?) WHERE id=?").run(this.now(), job.id);
        try {
          if (job.kind === 'event' && sub) {
            // Gate legacy queued events too, without forwarding suspect bodies.
            const body = JSON.parse(job.payload);
            if (typeof body?.data?.text !== 'string' || classifyText(body.data.text) === 'credential') { this.setState(job, 'blocked'); continue; }
            const response = await this.transport.post(sub.url, job.payload, this.signedHeaders(sub.id, inbox.id, job.payload, this.box.open(sub.secret), sub.oldSecret && sub.rotateUntil > this.now() ? this.box.open(sub.oldSecret) : undefined));
            if (response.status >= 200 && response.status < 300) this.setState(job, 'sent');
            else if (response.status === 410 || response.status === 413 || (response.status >= 400 && response.status < 500 && response.status !== 429)) { this.setState(job, 'dead'); if (response.status === 410) this.store.db.prepare('UPDATE subscriptions SET active=0 WHERE id=?').run(sub.id); }
            else this.retry(job);
          } else {
            // UUID length <=50; stable across retry and crash. Destination is NEVER supplied by a tool caller.
            const text = (JSON.parse(job.payload) as { text: string }).text;
            if (typeof text !== 'string' || classifyText(text) === 'credential') { this.setState(job, 'blocked'); continue; }
            await this.sender.reply(inbox.appId, inbox.messageId, text, hash(job.id).slice(0, 32)); this.setState(job, 'sent');
          }
        } catch { this.retry(job); }
      }
    } finally { this.pumping = false; }
    return processed;
  }
  private setState(job: Job, state: string) { this.store.db.prepare('UPDATE jobs SET state=? WHERE id=?').run(state, job.id); }
  private retry(job: Job) { const attempt = job.attempts + 1; if (attempt >= 8) this.setState(job, job.kind === 'reply' ? 'uncertain' : 'dead'); else this.store.db.prepare("UPDATE jobs SET state='pending',nextAt=? WHERE id=?").run(this.now() + Math.min(300000, 1000 * 2 ** (attempt - 1)), job.id); }
}
