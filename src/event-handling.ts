import { z } from 'zod';
import { waitNoticeSchema } from './status-card.js';
import { hash } from './crypto.js';
import { BridgeError, type Principal } from './types.js';
import type { Bridge } from './bridge.js';

const eventId = z.string().min(1).max(256);
export const handlingStatusSchema = z.object({ event_id: eventId }).strict();
export const handlingAlertsSchema = z.object({ after_seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0), limit: z.number().int().min(1).max(20).default(10) }).strict();
export const handlingClaimSchema = z.object({ event_id: eventId, request_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), lease_ms: z.number().int().min(1000).max(300000).default(60000), resume_waiting: z.literal('existing_user_authorization').optional() }).strict();
export const handlingCompleteSchema = z.discriminatedUnion('outcome', [
  z.object({ event_id: eventId, revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), outcome: z.literal('waiting_authorization'), notice:waitNoticeSchema.optional() }).strict(),
  z.object({ event_id: eventId, revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), outcome: z.literal('no_reply'), reason: z.enum(['sending_prohibited', 'no_response_needed']) }).strict(),
  z.object({ event_id: eventId, revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), outcome: z.literal('covered_by_reply'), covering_event_id: eventId }).strict()
]);
type Row = { eventId: string; state: string; revision: number; receivedAt: number; updatedAt: number; leaseUntil: number | null; claimDigest: string | null; reason: string | null; coveredBy: string | null; callbackAcceptedAt: number | null };
const replyStates = new Set(['pending','sending','sent','uncertain','cancelled','blocked','dead']);
export class EventHandling {
  constructor(private readonly bridge: Bridge, private readonly now: () => number) {}
  private row(id: string): Row {
    const r = this.bridge.store.db.prepare('SELECT * FROM event_handling WHERE eventId=?').get(id) as Row | undefined;
    if (!r) throw new BridgeError('handling_unavailable');
    return r;
  }
  private owned(p: Principal, id: string, recover = false) {
    // Auth and every identity column are checked before metadata lookup. Claiming
    // also applies the unchanged 24-hour reply/read window; status never sends.
    const b = this.bridge.currentEventBinding(p);
    if (!b || !this.bridge.store.ownedHandlingEvent(b,id)) throw new BridgeError('event_not_found',403);
    if (recover) this.bridge.getEvent(p,{event_id:id});
    return this.row(id);
  }
  status(p: Principal, input: unknown) {
    const {event_id:id} = handlingStatusSchema.parse(input), r = this.owned(p,id);
    const source=this.bridge.store.inbox(id)!;
    const timestamp=Date.parse(source.timestamp);
    const recoveryAvailable=Number.isFinite(timestamp) && timestamp<=this.now() && this.now()-timestamp<=86400000;
    const target = r.coveredBy ?? id;
    if (r.coveredBy) this.owned(p,target);
    const job = this.bridge.store.job('reply_'+hash(target));
    const callbacks = this.bridge.store.db.prepare("SELECT state FROM jobs WHERE inboxId=? AND kind='event' ORDER BY seq").all(id);
    const callbackSent = callbacks.some(c=>c.state==='sent');
    const liveLease = r.state==='processing' && r.leaseUntil!==null && r.leaseUntil>this.now();
    let alert: string | undefined;
    if (job) {
      if (job.state==='uncertain' || job.state==='sending') alert='delivery_requires_verification';
      else if (['dead','blocked','cancelled'].includes(job.state)) alert='reply_not_delivered';
    } else if (r.state==='waiting_authorization') alert='authorization_required';
    else if (r.state==='processing' && !liveLease) alert='processing_lease_expired';
    else if (r.state==='awaiting_processing' && this.now()-(r.callbackAcceptedAt??r.receivedAt)>=120000)
      alert=callbackSent?'callback_delivered_without_reply':'processing_not_started';
    return {event_id:id,handling_state:r.state,revision:r.revision,lease_active:liveLease,
      ...(r.leaseUntil!==null?{lease_until:new Date(r.leaseUntil).toISOString()}:{}),
      ...(r.reason?{reason:r.reason}:{}),...(r.coveredBy?{covering_event_id:r.coveredBy}:{}),
      callback_accepted:callbackSent,recovery_available:recoveryAvailable,reply_state:job?(replyStates.has(job.state)?job.state:'unknown'):'not_queued',
      ...(r.coveredBy?{reply_state_applies_to:r.coveredBy}:{}),...(alert?{alert}:{}),
      ...(r.state==='waiting_authorization'?{waiting_notification:this.bridge.output.eventWaitStatus(p,id,r.revision-1)}:{}),
      requires_existing_send_authorization:true as const};
  }
  alerts(p: Principal, input: unknown={}) {
    const args=handlingAlertsSchema.parse(input), b=this.bridge.currentEventBinding(p);
    if(!b)return {alerts:[],next_after_seq:null};
    const rows=this.bridge.store.ownedHandlingEvents(b,args.after_seq,args.limit+1);
    const page=rows.slice(0,args.limit), states=page.map(r=>this.status(p,{event_id:r.id}));
    return {alerts:states.filter(r=>'alert' in r),next_after_seq:rows.length>args.limit?page.at(-1)!.seq:null};
  }
  claim(p: Principal, input: unknown) {
    const a=handlingClaimSchema.parse(input);
    return this.bridge.store.transaction(()=>{
      const r=this.owned(p,a.event_id,true), digest=hash(a.request_id);
      if(r.state==='processing' && r.claimDigest===digest) return this.status(p,{event_id:a.event_id});
      if(r.revision>=Number.MAX_SAFE_INTEGER)throw new BridgeError('handling_revision_conflict');
      if(r.revision!==a.revision)throw new BridgeError('handling_revision_conflict');
      if(this.bridge.store.job('reply_'+hash(a.event_id)) || ['no_reply','reply_reserved','covered_by_reply'].includes(r.state))throw new BridgeError('handling_terminal');
      if(r.state==='waiting_authorization' && a.resume_waiting!=='existing_user_authorization')throw new BridgeError('handling_authorization_required');
      if(r.state!=='waiting_authorization' && a.resume_waiting)throw new BridgeError('invalid_handling_transition');
      if(r.state==='processing' && r.leaseUntil!==null && r.leaseUntil>this.now())throw new BridgeError('handling_busy');
      const until=Math.min(this.now()+a.lease_ms,p.expiresAt);
      this.bridge.store.db.prepare("UPDATE event_handling SET state='processing',revision=revision+1,updatedAt=?,leaseUntil=?,claimDigest=?,reason=NULL WHERE eventId=?")
        .run(this.now(),until,digest,a.event_id);
      return this.status(p,{event_id:a.event_id});
    });
  }
  complete(p: Principal, input: unknown) {
    const a=handlingCompleteSchema.parse(input);
    return this.bridge.store.transaction(()=>{
      const r=this.owned(p,a.event_id,true), reason=a.outcome==='waiting_authorization'?'authorization_required':a.outcome==='no_reply'?a.reason:'combined_reply';
      const covering=a.outcome==='covered_by_reply'?a.covering_event_id:null;
      if(r.revision===a.revision+1 && r.state===a.outcome && r.reason===reason && r.coveredBy===covering){
        if(a.outcome==='waiting_authorization' && a.notice) this.bridge.output.waitForEventInTransaction(p,a.event_id,a.revision,a.notice);
        return this.status(p,{event_id:a.event_id});
      }
      this.assertLease(r,a.revision);
      if(this.bridge.store.job('reply_'+hash(a.event_id)))throw new BridgeError('reply_already_reserved');
      if(covering){
        if(covering===a.event_id)throw new BridgeError('invalid_coverage');
        const anchor=this.owned(p,covering,true);
        // A real direct reply must already have been accepted. No chaining,
        // uncertain association, or dot-only answer can close another event.
        if(anchor.state!=='reply_reserved' || anchor.coveredBy || this.bridge.store.job('reply_'+hash(covering))?.state!=='sent')throw new BridgeError('covering_reply_not_sent');
      }
      if(a.outcome==='waiting_authorization' && a.notice) this.bridge.output.waitForEventInTransaction(p,a.event_id,a.revision,a.notice);
      this.bridge.store.db.prepare('UPDATE event_handling SET state=?,revision=revision+1,updatedAt=?,leaseUntil=NULL,claimDigest=NULL,reason=?,coveredBy=? WHERE eventId=?')
        .run(a.outcome,this.now(),reason,covering,a.event_id);
      return this.status(p,{event_id:a.event_id});
    });
  }
  private assertLease(r: Row, revision: number|undefined) {
    if(r.revision>=Number.MAX_SAFE_INTEGER || r.state!=='processing' || r.revision!==revision)throw new BridgeError('handling_revision_conflict');
    if(r.leaseUntil===null || r.leaseUntil<=this.now())throw new BridgeError('handling_lease_expired');
  }
  assertReplyAllowed(id: string, revision?: number) {
    const r=this.row(id);
    if(['waiting_authorization','no_reply','covered_by_reply'].includes(r.state))throw new BridgeError('handling_reply_prohibited');
    if(r.state==='processing')this.assertLease(r,revision);
    else if(revision!==undefined)throw new BridgeError('handling_revision_conflict');
  }
  recordReply(id: string) {
    this.bridge.store.db.prepare("UPDATE event_handling SET state='reply_reserved',revision=revision+1,updatedAt=?,leaseUntil=NULL,claimDigest=NULL WHERE eventId=?").run(this.now(),id);
  }
}
