import { Webhook } from 'standardwebhooks';
import { z } from 'zod';
import { hash, equal, randomToken, SecretBox } from './crypto.js';
import { Store } from './store.js';
import { BridgeError, type Principal, type Inbound, type Subscription, type CallbackTransport, type FeishuSender, type Binding, type Job } from './types.js';
export const EVENT_NAME = 'feishu.message.created';
export const subscriptionArgs = z.object({ binding_id: z.string().min(1).max(256) }).strict();
const deliverySchema = z.object({ mode: z.literal('webhook'), url: z.string().url().max(4096), secret: z.string().max(256) }).strict();
export const subscribeSchema = z.object({ name: z.literal(EVENT_NAME), arguments: subscriptionArgs, delivery: deliverySchema, cursor: z.null().optional(), ttlMs: z.number().int().positive().nullable().optional(), _meta: z.record(z.string(), z.unknown()).optional() }).strict();
export const unsubscribeSchema = z.object({ name: z.literal(EVENT_NAME), arguments: subscriptionArgs, delivery: deliverySchema.omit({ secret: true }), _meta: z.record(z.string(), z.unknown()).optional() }).strict();
export const replySchema = z.object({ event_id: z.string().min(1).max(256), text: z.string().min(1).max(12000) }).strict();
export function validSecret(secret: string): boolean { if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) return false; const b = Buffer.from(secret.slice(6), 'base64'); return b.length >= 24 && b.length <= 64 && b.toString('base64').replace(/=+$/, '') === secret.slice(6).replace(/=+$/, ''); }
export class Bridge {
  private pumping = false;
  constructor(readonly store: Store, private box: SecretBox, private transport: CallbackTransport, private sender: FeishuSender, private now: () => number = Date.now) {}
  private authorize(p: Principal) { if (p.expiresAt <= this.now() || this.store.isRevoked(p.id)) throw new BridgeError('unauthorized', 401); }
  beginBinding(p: Principal) { this.authorize(p); if (this.store.binding(p.id)) throw new BridgeError('already_bound_unlink_first'); const code = randomToken(); const expiresAt = Math.min(this.now() + 300000, p.expiresAt); this.store.transaction(() => { this.store.db.prepare('DELETE FROM pairs WHERE owner=? OR expiresAt<=?').run(p.id, this.now()); this.store.db.prepare('INSERT INTO pairs VALUES (?,?,?)').run(hash(code), p.id, expiresAt); }); return { command: `/bind ${code}`, expires_at: new Date(expiresAt).toISOString(), instruction: 'Send this command only in a private chat with the intended Feishu bot. Then check binding_status. Never share this code.' }; }
  status(p: Principal) { this.authorize(p); const b = this.store.binding(p.id); return b ? { bound: true, binding_id: b.id, app_id: b.appId, tenant_key: b.tenantKey, open_id: b.openId } : { bound: false }; }
  unlink(p: Principal) { this.authorize(p); this.store.transaction(() => { this.store.db.prepare('UPDATE bindings SET active=0 WHERE owner=?').run(p.id); this.store.db.prepare('UPDATE subscriptions SET active=0 WHERE owner=?').run(p.id); this.store.db.prepare('DELETE FROM pairs WHERE owner=?').run(p.id); this.store.db.prepare("UPDATE jobs SET state='cancelled' WHERE inboxId IN (SELECT id FROM inbox WHERE owner=?) AND state='pending'").run(p.id); }); return { unlinked: true }; }
  receive(m: Inbound): { state: string } {
    return this.store.transaction(() => {
      const receiptId = hash(JSON.stringify([m.appId, m.tenantKey, m.messageId]));
      if (this.store.db.prepare('SELECT id FROM receipts WHERE id=?').get(receiptId)) return { state: 'duplicate' };
      this.store.db.prepare('INSERT INTO receipts VALUES (?,?)').run(receiptId, this.now());
      if (m.text.startsWith('/bind')) {
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
      const eventId = `evt_${receiptId}`;
      this.store.db.prepare('INSERT INTO inbox(id,owner,bindingId,appId,tenantKey,openId,messageId,chatId,text,timestamp) VALUES (?,?,?,?,?,?,?,?,?,?)').run(eventId, binding.owner, binding.id, m.appId, m.tenantKey, m.openId, m.messageId, m.chatId, m.text, m.timestamp);
      const subscriptions = this.store.db.prepare('SELECT * FROM subscriptions WHERE bindingId=? AND active=1 AND expiresAt>?').all(binding.id, this.now()) as unknown as Subscription[];
      for (const sub of subscriptions) {
        const payload = JSON.stringify({ eventId, name: EVENT_NAME, timestamp: m.timestamp, data: { event_id: eventId, binding_id: binding.id, text: m.text }, cursor: null });
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
    try { response = await this.transport.post(args.delivery.url, body, this.signedHeaders(id, `verify_${randomToken()}`, body, args.delivery.secret)); } catch { throw new BridgeError('callback_verification_failed'); }
    let echoed: unknown; try { echoed = JSON.parse(response.body)?.challenge; } catch { /* rejected below */ }
    if (this.now() - started > 10000 || response.status < 200 || response.status >= 300 || typeof echoed !== 'string' || !equal(challenge, echoed)) throw new BridgeError('callback_verification_failed');
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
      const id = `reply_${hash(args.event_id)}`, payload = JSON.stringify({ text: args.text }); const existing = this.store.job(id);
      if (existing) { if (existing.payload !== payload) throw new BridgeError('reply_already_reserved'); return { reply_id: id, state: existing.state }; }
      this.store.db.prepare('INSERT INTO jobs(id,kind,lane,inboxId,payload,accessUntil) VALUES (?,?,?,?,?,?)').run(id, 'reply', `reply:${inbox.bindingId}`, inbox.id, payload, p.expiresAt);
      return { reply_id: id, state: 'pending' };
    });
  }
  deliveryStatus(p: Principal, eventId: string) { this.authorize(p); const inbox = this.store.inbox(eventId); if (!inbox || inbox.owner !== p.id || !this.store.bindingById(inbox.bindingId)) throw new BridgeError('event_not_found', 403); const job = this.store.job(`reply_${hash(eventId)}`); return { event_id: eventId, state: job?.state ?? 'not_queued', attempts: job?.attempts ?? 0 }; }
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
        // Earlier pending jobs block later jobs in their lane, even during backoff.
        const job = this.store.db.prepare(`SELECT * FROM jobs j WHERE j.state='pending' AND j.nextAt<=? AND NOT EXISTS (SELECT 1 FROM jobs p WHERE p.lane=j.lane AND p.seq<j.seq AND p.state IN ('pending','sending')) ORDER BY j.seq LIMIT 1`).get(this.now()) as Job | undefined;
        if (!job) break; processed++;
        const inbox = this.store.inbox(job.inboxId), binding = inbox && this.store.bindingById(inbox.bindingId);
        const sub = job.subscriptionId ? this.store.subscription(job.subscriptionId) : undefined;
        if (!inbox || !binding || this.store.isRevoked(inbox.owner) || (job.kind === 'event' && (!sub || !sub.active || sub.expiresAt <= this.now() || sub.bindingId !== binding.id))) { this.setState(job, 'cancelled'); continue; }
        if (job.kind === 'reply' && ((job.firstAttemptAt !== null && this.now() - job.firstAttemptAt >= 55 * 60000) || job.accessUntil <= this.now())) { this.setState(job, job.firstAttemptAt === null ? 'cancelled' : 'uncertain'); continue; }
        this.store.db.prepare("UPDATE jobs SET state='sending',attempts=attempts+1,firstAttemptAt=COALESCE(firstAttemptAt,?) WHERE id=?").run(this.now(), job.id);
        try {
          if (job.kind === 'event' && sub) {
            const response = await this.transport.post(sub.url, job.payload, this.signedHeaders(sub.id, inbox.id, job.payload, this.box.open(sub.secret), sub.oldSecret && sub.rotateUntil > this.now() ? this.box.open(sub.oldSecret) : undefined));
            if (response.status >= 200 && response.status < 300) this.setState(job, 'sent');
            else if (response.status === 410 || response.status === 413 || (response.status >= 400 && response.status < 500 && response.status !== 429)) { this.setState(job, 'dead'); if (response.status === 410) this.store.db.prepare('UPDATE subscriptions SET active=0 WHERE id=?').run(sub.id); }
            else this.retry(job);
          } else {
            // UUID length <=50; stable across retry and crash. Destination is NEVER supplied by a tool caller.
            await this.sender.reply(inbox.appId, inbox.messageId, (JSON.parse(job.payload) as { text: string }).text, hash(job.id).slice(0, 32)); this.setState(job, 'sent');
          }
        } catch { this.retry(job); }
      }
    } finally { this.pumping = false; }
    return processed;
  }
  private setState(job: Job, state: string) { this.store.db.prepare('UPDATE jobs SET state=? WHERE id=?').run(state, job.id); }
  private retry(job: Job) { const attempt = job.attempts + 1; if (attempt >= 8) this.setState(job, job.kind === 'reply' ? 'uncertain' : 'dead'); else this.store.db.prepare("UPDATE jobs SET state='pending',nextAt=? WHERE id=?").run(this.now() + Math.min(300000, 1000 * 2 ** (attempt - 1)), job.id); }
}
