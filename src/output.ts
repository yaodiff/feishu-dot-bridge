import { createHash } from 'node:crypto';
import { z } from 'zod';
import { hash, type SecretBox } from './crypto.js';
import { BridgeError, type Principal, type FeishuSender, type Binding } from './types.js';
import type { Bridge } from './bridge.js';
import { statusCardSchema, buildStatusCard } from './status-card.js';
import { inspectMedia, MEDIA_LIMITS } from './media-policy.js';
import { sanitizeImage } from './media-image.js';
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const outputStatusSchema = z.object({ output_id:id }).strict();
export const outputAlertsSchema = z.object({ after_seq:z.number().int().nonnegative().default(0), limit:z.number().int().min(1).max(50).default(20) }).strict();
export const imageChunkSchema = z.object({ binding_id:id, source_message_id:id, sha256:digest, mime_type:z.enum(['image/png','image/jpeg']),
  generated_at:z.string().datetime(), source:z.literal('current_generated_image'), existing_user_authorization:z.literal(true),
  chunk_index:z.number().int().min(0).max(42), total_chunks:z.number().int().min(1).max(43), chunk_base64:z.string().min(4).max(131072).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
}).strict();
export const imageSendSchema = z.object({ binding_id:id, transfer_id:id, request_id:id, existing_user_authorization:z.literal(true) }).strict();
interface OutputRow { seq:number; id:string; owner:string; bindingId:string; requestId:string; kind:'image'|'card'; taskId:string|null; revision:number|null; targetMessageId:string|null; payload:string; digest:string; state:string; phase:string; attempts:number; createdAt:number; accessUntil:number; remoteMessageId:string|null; imageKey:string|null; completedAt:number|null; failure:string|null }
interface MediaRow { id:string; owner:string; bindingId:string; sourceId:string; digest:string; mime:'image/png'|'image/jpeg'; generatedAt:number; expiresAt:number; totalChunks:number; consumed:number }
export type OutputDecoder = (bytes:Buffer, mime:string, signal:AbortSignal) => Promise<{bytes:Buffer}>;
/** Explicit submissions only. No capture hook, URL download, file reader or approval handler. */
export class OutputDelivery {
  constructor(private bridge:Bridge, private box:SecretBox, private sender:FeishuSender, private now:()=>number, private decode:OutputDecoder = sanitizeImage, readonly imagesEnabled=false) {}
  private get db() { return this.bridge.store.db; }
  private binding(p:Principal, guard?:string):Binding {
    // status enforces principal expiry, revocation and installation ownership.
    this.bridge.status(p); const b=this.bridge.store.binding(p.id);
    if (!b || (guard !== undefined && guard !== b.id)) throw new BridgeError('binding_changed',403);
    return b;
  }
  private row(id:string) { return this.db.prepare('SELECT * FROM output_outbox WHERE id=?').get(id) as unknown as OutputRow|undefined; }
  private result(r:OutputRow) { return { output_id:r.id, seq:r.seq, kind:r.kind, state:r.state, phase:r.phase, attempts:r.attempts, revision:r.revision,
    ...(r.remoteMessageId ? {message_id:r.remoteMessageId} : {}), ...(r.imageKey ? {image_key:r.imageKey, upload_accepted:true} : {}),
    ...(r.completedAt !== null ? {api_accepted_at:new Date(r.completedAt).toISOString()} : {}), ...(r.failure ? {failure:r.failure} : {}),
    requires_attention:['failed','blocked','uncertain','cancelled'].includes(r.state), api_accepted:r.state==='sent' }; }
  status(p:Principal, input:unknown) {
    const b=this.binding(p), a=outputStatusSchema.parse(input), r=this.row(a.output_id);
    if (!r || r.owner!==p.id || r.bindingId!==b.id) throw new BridgeError('output_not_found',404);
    return this.result(r);
  }
  alerts(p:Principal,input:unknown) {
    const b=this.binding(p), a=outputAlertsSchema.parse(input);
    const rows=this.db.prepare('SELECT * FROM output_outbox WHERE owner=? AND bindingId=? AND seq>? ORDER BY seq LIMIT ?').all(p.id,b.id,a.after_seq,a.limit) as unknown as OutputRow[];
    return {outputs:rows.filter(r=>r.state!=='sent').map(r=>this.result(r)),next_after_seq:rows.at(-1)?.seq ?? a.after_seq, scan_from_zero_again:true};
  }
  card(p:Principal,input:unknown) {
    const a=statusCardSchema.parse(input), b=this.binding(p,a.binding_id), payload=JSON.stringify(buildStatusCard(a));
    const bodyDigest=hash(JSON.stringify(a)), outputId='out_'+hash(JSON.stringify([p.id,b.id,a.request_id]));
    return this.bridge.store.transaction(()=>{
      const existing=this.row(outputId); if(existing) { if(existing.digest!==bodyDigest) throw new BridgeError('output_request_conflict'); return this.result(existing); }
      const previous=this.db.prepare("SELECT * FROM output_outbox WHERE owner=? AND bindingId=? AND kind='card' AND taskId=? ORDER BY revision DESC LIMIT 1").get(p.id,b.id,a.task_id) as unknown as OutputRow|undefined;
      if((previous?.revision ?? 0)!==a.expected_revision) throw new BridgeError('status_revision_conflict');
      if(previous && previous.state!=='sent') throw new BridgeError('previous_status_unresolved');
      const target=a.status==='waiting_confirmation' ? null : previous?.remoteMessageId ?? null;
      this.reserve(p,b,outputId,a.request_id,'card',payload,bodyDigest,a.task_id,a.expected_revision+1,target);
      return this.result(this.row(outputId)!);
    });
  }
  chunk(p:Principal,input:unknown) {
    if(!this.imagesEnabled) throw new BridgeError('image_output_disabled');
    const a=imageChunkSchema.parse(input), b=this.binding(p,a.binding_id), at=Date.parse(a.generated_at);
    if(a.chunk_index>=a.total_chunks || at>this.now()+60000 || at<this.now()-MEDIA_LIMITS.referenceTtlMs) throw new BridgeError('image_source_expired');
    const bytes=Buffer.from(a.chunk_base64,'base64');
    try {
      if(bytes.toString('base64')!==a.chunk_base64 || bytes.length>98304) throw new BridgeError('invalid_image_chunk');
      const mediaId='media_'+hash(JSON.stringify([p.id,b.id,a.source_message_id]));
      return this.bridge.store.transaction(()=>{
        this.cleanupInTransaction();
        let m=this.db.prepare('SELECT * FROM output_media WHERE id=?').get(mediaId) as unknown as MediaRow|undefined;
        if(!m) {
          const n=Number(this.db.prepare('SELECT COUNT(*) AS n FROM output_media WHERE consumed=0 AND expiresAt>?').get(this.now())!.n);
          const ownerN=Number(this.db.prepare('SELECT COUNT(*) AS n FROM output_media WHERE owner=? AND consumed=0 AND expiresAt>?').get(p.id,this.now())!.n);
          if(n>=16 || ownerN>=2) throw new BridgeError('image_staging_capacity');
          this.db.prepare('INSERT INTO output_media(id,owner,bindingId,sourceId,digest,mime,generatedAt,expiresAt,totalChunks) VALUES (?,?,?,?,?,?,?,?,?)').run(mediaId,p.id,b.id,a.source_message_id,a.sha256,a.mime_type,at,Math.min(at+MEDIA_LIMITS.referenceTtlMs,p.expiresAt),a.total_chunks);
          m=this.db.prepare('SELECT * FROM output_media WHERE id=?').get(mediaId) as unknown as MediaRow;
        }
        if(m.digest!==a.sha256 || m.mime!==a.mime_type || m.generatedAt!==at || m.totalChunks!==a.total_chunks) throw new BridgeError('image_source_conflict');
        if(m.expiresAt<=this.now() || m.consumed) throw new BridgeError('image_transfer_closed');
        const chunkDigest=createHash('sha256').update(bytes).digest('hex');
        const old=this.db.prepare('SELECT digest FROM output_chunks WHERE mediaId=? AND part=?').get(mediaId,a.chunk_index);
        if(old && old.digest!==chunkDigest) throw new BridgeError('image_chunk_conflict');
        if(!old) this.db.prepare('INSERT INTO output_chunks VALUES (?,?,?,?)').run(mediaId,a.chunk_index,chunkDigest,this.box.seal(a.chunk_base64));
        return {transfer_id:mediaId,received_chunks:Number(this.db.prepare('SELECT COUNT(*) AS n FROM output_chunks WHERE mediaId=?').get(mediaId)!.n),total_chunks:m.totalChunks,expires_at:new Date(m.expiresAt).toISOString(),state:'staging',sent:false};
      });
    } finally {bytes.fill(0);}
  }
  image(p:Principal,input:unknown) {
    if(!this.imagesEnabled) throw new BridgeError('image_output_disabled');
    const a=imageSendSchema.parse(input), b=this.binding(p,a.binding_id), outputId='out_'+hash(JSON.stringify([p.id,b.id,a.request_id])), bodyDigest=hash(JSON.stringify(a));
    return this.bridge.store.transaction(()=>{
      const existing=this.row(outputId); if(existing) {if(existing.digest!==bodyDigest) throw new BridgeError('output_request_conflict'); return this.result(existing);}
      const m=this.db.prepare('SELECT * FROM output_media WHERE id=? AND owner=? AND bindingId=?').get(a.transfer_id,p.id,b.id) as unknown as MediaRow|undefined;
      if(!m || m.consumed || m.expiresAt<=this.now()) throw new BridgeError('image_transfer_unavailable');
      const chunks=this.db.prepare('SELECT encrypted FROM output_chunks WHERE mediaId=? ORDER BY part').all(m.id);
      if(chunks.length!==m.totalChunks) throw new BridgeError('image_transfer_incomplete');
      const parts=chunks.map(c=>Buffer.from(this.box.open(String(c.encrypted)),'base64')), bytes=Buffer.concat(parts);
      try {
        if(createHash('sha256').update(bytes).digest('hex')!==m.digest) throw new BridgeError('image_digest_mismatch');
        inspectMedia(bytes,'image',m.mime);
        this.reserve(p,b,outputId,a.request_id,'image',JSON.stringify({mime:m.mime,base64:bytes.toString('base64')}),bodyDigest,null,null,null,m.expiresAt);
        this.db.prepare('UPDATE output_media SET consumed=1 WHERE id=?').run(m.id);
        this.db.prepare('DELETE FROM output_chunks WHERE mediaId=?').run(m.id);
        return this.result(this.row(outputId)!);
      } finally {bytes.fill(0); for(const part of parts) part.fill(0);}
    });
  }
  private reserve(p:Principal,b:Binding,id:string,request:string,kind:string,payload:string,digest:string,task:string|null,revision:number|null,target:string|null,expiry=p.expiresAt) {
    if(Number(this.db.prepare("SELECT COUNT(*) AS n FROM output_outbox WHERE owner=? AND state IN ('pending','sending')").get(p.id)!.n)>=32) throw new BridgeError('output_capacity');
    this.db.prepare('INSERT INTO output_outbox(id,owner,bindingId,requestId,kind,taskId,revision,targetMessageId,payload,digest,createdAt,accessUntil) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id,p.id,b.id,request,kind,task,revision,target,this.box.seal(payload),digest,this.now(),Math.min(expiry,p.expiresAt));
  }
  cleanup() { this.bridge.store.transaction(()=>this.cleanupInTransaction()); }
  private cleanupInTransaction() {
    // Retain closed tombstones for deduplication, but release their staging quota.
    this.db.prepare('UPDATE output_media SET consumed=1 WHERE consumed=0 AND (expiresAt<=? OR bindingId NOT IN (SELECT id FROM bindings WHERE active=1) OR owner IN (SELECT owner FROM revoked))').run(this.now());
    this.db.prepare('DELETE FROM output_chunks WHERE mediaId IN (SELECT id FROM output_media WHERE consumed=1)').run();
    this.db.prepare("UPDATE output_outbox SET state='cancelled',phase='cancelled',payload='',failure='access_expired' WHERE state='pending' AND accessUntil<=?").run(this.now());
  }
  async pumpOne():Promise<boolean> {
    this.cleanup();
    // Reserve under the SQLite writer lock before any decode/network work.
    const r=this.bridge.store.transaction(()=>{
      const row=this.db.prepare("SELECT * FROM output_outbox WHERE state='pending' ORDER BY CASE WHEN kind='card' THEN 0 ELSE 1 END,seq LIMIT 1").get() as unknown as OutputRow|undefined;
      if(!row) return undefined;
      this.db.prepare("UPDATE output_outbox SET state='sending',phase='preflight',attempts=1 WHERE id=? AND state='pending'").run(row.id);
      return row;
    });
    if(!r) return false;
    let networkStarted=false, bytes:Buffer|undefined, clean:Buffer|undefined;
    const fail=(state:string,reason:string)=>this.db.prepare("UPDATE output_outbox SET state=?,failure=?,payload='' WHERE id=?").run(state,reason,r.id);
    try {
      const b=this.bridge.store.bindingById(r.bindingId);
      if(!b || b.owner!==r.owner || this.bridge.store.isRevoked(r.owner) || r.accessUntil<=this.now()) { fail('cancelled','binding_or_access_changed'); return true; }
      const payload=JSON.parse(this.box.open(r.payload));
      let messageId:string;
      const valid=()=>{const current=this.bridge.store.bindingById(r.bindingId); if(!current || current.owner!==r.owner || this.bridge.store.isRevoked(r.owner) || r.accessUntil<=this.now()) throw new BridgeError('binding_or_access_changed');};
      if(r.kind==='image') {
        if(!this.imagesEnabled) { fail('blocked','image_output_disabled'); return true; }
        if(!this.sender.uploadImage || !this.sender.sendImage) throw new BridgeError('output_transport_unavailable');
        bytes=Buffer.from(payload.base64,'base64'); clean=(await this.decode(bytes,payload.mime,new AbortController().signal)).bytes;
        inspectMedia(clean,'image','image/png'); valid();
        this.db.prepare("UPDATE output_outbox SET phase='uploading' WHERE id=?").run(r.id); networkStarted=true;
        const imageKey=await this.sender.uploadImage(b.appId,clean);
        if(!/^img_[A-Za-z0-9_-]{1,240}$/.test(imageKey)) throw new BridgeError('invalid_output_receipt');
        this.db.prepare("UPDATE output_outbox SET phase='uploaded',imageKey=? WHERE id=?").run(imageKey,r.id);
        valid(); this.db.prepare("UPDATE output_outbox SET phase='sending_image' WHERE id=?").run(r.id);
        messageId=await this.sender.sendImage(b.appId,b.chatId,imageKey,hash(r.id).slice(0,32));
      } else {
        if(!this.sender.sendCard || !this.sender.patchCard) throw new BridgeError('output_transport_unavailable');
        valid(); this.db.prepare("UPDATE output_outbox SET phase=? WHERE id=?").run(r.targetMessageId?'patching_card':'sending_card',r.id); networkStarted=true;
        if(r.targetMessageId) {await this.sender.patchCard(b.appId,r.targetMessageId,payload); messageId=r.targetMessageId;}
        else messageId=await this.sender.sendCard(b.appId,b.chatId,payload,hash(r.id).slice(0,32));
      }
      if(!/^om_[A-Za-z0-9_-]{1,240}$/.test(messageId)) throw new BridgeError('invalid_output_receipt');
      this.db.prepare("UPDATE output_outbox SET state='sent',phase='accepted',remoteMessageId=?,completedAt=?,payload='' WHERE id=?").run(messageId,this.now(),r.id);
    } catch(error) {
      const rejected=error instanceof BridgeError && error.code==='feishu_output_rejected';
      const reason=error instanceof BridgeError && ['output_transport_unavailable','binding_or_access_changed','image_decoder_unavailable','image_dimensions_exceeded','invalid_media_content','unsupported_image_format','invalid_output_receipt'].includes(error.code) ? error.code : rejected?'provider_rejected':networkStarted?'transport_or_receipt_uncertain':'image_validation_failed';
      fail(networkStarted && !rejected?'uncertain':'failed',reason);
    } finally {bytes?.fill(0);clean?.fill(0);}
    return true;
  }
}
