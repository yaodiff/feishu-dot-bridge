/** Synthetic pixels and mocked provider only. No production connection or user artifacts. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {fixture} from './fixtures.js';
import {OutputDelivery} from '../src/output.js';
import {SecretBox} from '../src/crypto.js';
import {Store} from '../src/store.js';
import {BridgeError} from '../src/types.js';
import {DOT_ENTRY,buildStatusCard} from '../src/status-card.js';
import {makeApp} from '../src/http.js';
const code=(c:string)=>(e:unknown)=>e instanceof BridgeError && e.code===c;
const png=()=>sharp({create:{width:12,height:8,channels:4,background:'#369aff'}}).png().toBuffer();
function setup(path=':memory:') {
 const f=fixture(path),binding=f.store.binding(f.alice.id) ?? f.bind(),calls:unknown[]=[];
 f.sender.uploadImage=async(_app,bytes)=>{calls.push({upload:bytes.length});return 'img_SYNTHETIC';};
 f.sender.sendImage=async(app,chat,key,uuid)=>{calls.push({app,chat,key,uuid});return 'om_SYNTHETIC_image';};
 f.sender.sendCard=async(app,chat,card,uuid)=>{calls.push({app,chat,card,uuid});return 'om_SYNTHETIC_card_'+calls.length;};
 f.sender.patchCard=async(app,message,card)=>{calls.push({app,message,card});};
 // Mock seam uses real sharp for generated pixels only; production still requires Linux prlimit.
 const output=new OutputDelivery(f.bridge,new SecretBox(f.storageKey),f.sender,f.now,async(bytes)=>({bytes:await sharp(bytes).png().toBuffer()}),true);
 const card=(request:string,revision=0,status:'processing'|'waiting_confirmation'|'completed'|'failed'|'blocked'='processing')=>({binding_id:binding.id,request_id:request,task_id:'MOCK_task',expected_revision:revision,status,summary:'合成测试进度',existing_user_authorization:true as const,...(status==='waiting_confirmation'?{action:'确认发布合成候选',reason:'此动作需要用户检查'}:{}),...(['failed','blocked'].includes(status)?{reason:'合成阻塞原因'}:{})});
 const chunk=(bytes:Buffer,source='MOCK_generated',extra={})=>({binding_id:binding.id,source_message_id:source,sha256:createHash('sha256').update(bytes).digest('hex'),mime_type:'image/png' as const,generated_at:new Date(f.now()).toISOString(),source:'current_generated_image' as const,existing_user_authorization:true as const,chunk_index:0,total_chunks:1,chunk_base64:bytes.toString('base64'),...extra});
 const send=(transfer:string,request='MOCK_send')=>({binding_id:binding.id,transfer_id:transfer,request_id:request,existing_user_authorization:true});
 return {...f,binding,calls,output,card,chunk,send};
}
test('cards persist, deduplicate, patch normal progress and newly notify every explicit wait',async()=>{
 const f=setup();try {
 const first=f.output.card(f.alice,f.card('start'));assert.equal(first.state,'pending');assert.equal(f.calls.length,0);
 assert.equal(f.output.card(f.alice,f.card('start')).output_id,first.output_id);
 assert.throws(()=>f.output.card(f.alice,{...f.card('start'),summary:'different'}),code('output_request_conflict'));
 assert.throws(()=>f.output.card(f.alice,f.card('next',1)),code('previous_status_unresolved'));
 await f.output.pumpOne();const receipt=f.output.status(f.alice,{output_id:first.output_id});assert.equal(receipt.state,'sent');assert.ok(receipt.message_id);assert.equal(receipt.attempts,1);
 const next=f.output.card(f.alice,f.card('next',1));await f.output.pumpOne();assert.equal(f.output.status(f.alice,{output_id:next.output_id}).message_id,receipt.message_id);assert.ok('message' in (f.calls[1] as object));
 const wait=f.output.card(f.alice,f.card('wait',2,'waiting_confirmation'));await f.output.pumpOne();assert.notEqual(f.output.status(f.alice,{output_id:wait.output_id}).message_id,receipt.message_id);
 const again=f.output.card(f.alice,f.card('wait_again',3,'waiting_confirmation'));await f.output.pumpOne();assert.notEqual(f.output.status(f.alice,{output_id:again.output_id}).message_id,f.output.status(f.alice,{output_id:wait.output_id}).message_id);
 const done=f.output.card(f.alice,f.card('done',4,'completed'));await f.output.pumpOne();assert.equal(f.output.status(f.alice,{output_id:done.output_id}).state,'sent');
 assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM output_outbox').get()!.n,5);
 assert.equal(f.output.alerts(f.alice,{}).outputs.length,0);
 assert.throws(()=>f.output.card(f.alice,f.card('stale',0)),code('status_revision_conflict'));
 }finally{f.store.close();}
});
test('waiting card has plain action/reason, official navigation only and no approval callback',()=>{
 const f=setup();try {
 assert.throws(()=>f.output.card(f.alice,{...f.card('wait',0,'waiting_confirmation'),action:undefined}));
 const card=buildStatusCard(f.card('wait',0,'waiting_confirmation'));
 assert.match(card.header.title.content,/等待确认/);assert.match(card.config.summary.content,/等待确认/);
 const raw=JSON.stringify(card);assert.ok(raw.includes(DOT_ENTRY));assert.ok(raw.includes('不授予 dot 权限'));assert.equal(raw.includes('callback'),false);assert.equal(raw.includes('value'),false);
 assert.throws(()=>f.output.card(f.alice,{...f.card('fake'),url:'https://attacker.invalid'}));
 assert.throws(()=>f.output.card(f.alice,{...f.card('secret'),summary:'Bearer abcdefghijklmnopqrstuvwxyz123456'}),code('credential_blocked'));
 }finally{f.store.close();}
});
test('real generated PNG bytes stage encrypted, upload then image send, with independent receipts',async()=>{
 const f=setup();try {
 const bytes=await png(),a=f.chunk(bytes),stage=f.output.chunk(f.alice,a);
 assert.equal(stage.sent,false);assert.equal(f.output.chunk(f.alice,a).received_chunks,1);
 const encrypted=String(f.store.db.prepare('SELECT encrypted FROM output_chunks').get()!.encrypted);assert.ok(!encrypted.includes(a.chunk_base64));
 const queued=f.output.image(f.alice,f.send(stage.transfer_id));assert.equal(queued.state,'pending');assert.equal(f.calls.length,0);
 assert.equal(f.output.image(f.alice,f.send(stage.transfer_id)).output_id,queued.output_id);
 assert.throws(()=>f.output.image(f.alice,f.send(stage.transfer_id,'different')),code('image_transfer_unavailable'));
 assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM output_chunks').get()!.n,0);
 await f.output.pumpOne();const result=f.output.status(f.alice,{output_id:queued.output_id});
 assert.equal(result.state,'sent');assert.equal(result.upload_accepted,true);assert.equal(result.image_key,'img_SYNTHETIC');assert.equal(result.message_id,'om_SYNTHETIC_image');assert.equal(f.calls.length,2);
 assert.equal(f.store.db.prepare('SELECT payload FROM output_outbox').get()!.payload,'');
 await f.output.pumpOne();assert.equal(f.calls.length,2);
 }finally{f.store.close();}
});
test('chunk protocol accepts JPEG, multi-chunk content, fixed digest, MIME and source; rejects URL/path/foreign access',async()=>{
 const f=setup();try {
 const bytes=await sharp({create:{width:10,height:9,channels:3,background:'#cafe00'}}).jpeg().toBuffer();
 const whole=f.chunk(bytes,'MOCK_jpeg',{mime_type:'image/jpeg',total_chunks:2,chunk_base64:bytes.subarray(0,30).toString('base64')});
 const stage=f.output.chunk(f.alice,whole);assert.throws(()=>f.output.image(f.alice,f.send(stage.transfer_id)),code('image_transfer_incomplete'));
 assert.throws(()=>f.output.chunk(f.alice,{...whole,chunk_base64:Buffer.from('different').toString('base64')}),code('image_chunk_conflict'));
 f.output.chunk(f.alice,{...whole,chunk_index:1,chunk_base64:bytes.subarray(30).toString('base64')});
 const queued=f.output.image(f.alice,f.send(stage.transfer_id));await f.output.pumpOne();assert.equal(f.output.status(f.alice,{output_id:queued.output_id}).state,'sent');
 for(const extra of [{url:'https://127.0.0.1/'},{path:'/etc/passwd'},{source:'received_image'},{existing_user_authorization:false}]) assert.throws(()=>f.output.chunk(f.alice,f.chunk(awaitNever(),'bad',extra)));
 assert.throws(()=>f.output.status(f.bob,{output_id:queued.output_id}),code('binding_changed'));
 assert.throws(()=>f.output.chunk(f.alice,{...whole,binding_id:'unbound'}),code('binding_changed'));
 }finally{f.store.close();}
});
function awaitNever(){return Buffer.from('SYNTHETIC_invalid');}
test('expiry, canonical base64, SHA, MIME, dimension and size restrictions prevent outbound calls',async()=>{
 const f=setup();try {
 const bytes=await png();
 assert.throws(()=>f.output.chunk(f.alice,f.chunk(bytes,'future',{generated_at:new Date(f.now()+120000).toISOString()})),code('image_source_expired'));
 assert.throws(()=>f.output.chunk(f.alice,f.chunk(bytes,'oversized',{chunk_base64:Buffer.alloc(98305).toString('base64')})));
 const stage=f.output.chunk(f.alice,f.chunk(bytes,'wrong_digest',{sha256:'a'.repeat(64)}));assert.throws(()=>f.output.image(f.alice,f.send(stage.transfer_id)),code('image_digest_mismatch'));
 const mismatch=f.output.chunk(f.alice,f.chunk(bytes,'wrong_mime',{mime_type:'image/jpeg'}));assert.throws(()=>f.output.image(f.alice,f.send(mismatch.transfer_id)),code('media_mime_mismatch'));
 f.advance(16*60000);f.output.cleanup();assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM output_chunks').get()!.n,0);
 assert.throws(()=>f.output.image(f.alice,f.send(stage.transfer_id)),code('image_transfer_unavailable'));assert.equal(f.calls.length,0);
 }finally{f.store.close();}
});
test('uncertain send keeps upload receipt, is alerted and cannot be resent with another request',async()=>{
 const f=setup();try {
 f.sender.sendImage=async()=>{throw new Error('SYNTHETIC private error must not persist');};
 const stage=f.output.chunk(f.alice,f.chunk(await png())),job=f.output.image(f.alice,f.send(stage.transfer_id));
 await f.output.pumpOne();const result=f.output.status(f.alice,{output_id:job.output_id});assert.equal(result.state,'uncertain');assert.equal(result.upload_accepted,true);assert.equal(result.message_id,undefined);
 assert.equal(f.output.alerts(f.alice,{}).outputs.length,1);assert.equal(f.output.image(f.alice,f.send(stage.transfer_id)).state,'uncertain');assert.throws(()=>f.output.image(f.alice,f.send(stage.transfer_id,'new')),code('image_transfer_unavailable'));
 await f.output.pumpOne();assert.equal(f.calls.length,1);assert.ok(!JSON.stringify(f.store.db.prepare('SELECT * FROM output_outbox').all()).includes('private error'));
 }finally{f.store.close();}
});
test('provider rejection and malformed receipt cannot report success; normal card waits stop after failed predecessor',async()=>{
 const f=setup();try {
 f.sender.sendCard=async()=>{throw new BridgeError('feishu_output_rejected',502);};
 const job=f.output.card(f.alice,f.card('fail'));await f.output.pumpOne();assert.equal(f.output.status(f.alice,{output_id:job.output_id}).state,'failed');
 assert.throws(()=>f.output.card(f.alice,f.card('after',1)),code('previous_status_unresolved'));
 f.sender.sendCard=async()=>'';const job2=f.output.card(f.alice,{...f.card('empty'),task_id:'other'});await f.output.pumpOne();assert.equal(f.output.status(f.alice,{output_id:job2.output_id}).state,'uncertain');
 }finally{f.store.close();}
});
test('unlink/revoke and expired access cancel pending images/cards without sending or leaking staged bytes',async()=>{
 const f=setup();try {
 const stage=f.output.chunk(f.alice,f.chunk(await png())),job=f.output.image(f.alice,f.send(stage.transfer_id));f.bridge.unlink(f.alice);await f.output.pumpOne();assert.equal(f.calls.length,0);assert.equal(f.store.db.prepare('SELECT state FROM output_outbox WHERE id=?').get(job.output_id)!.state,'cancelled');
 assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM output_chunks').get()!.n,0);assert.throws(()=>f.output.status(f.alice,{output_id:job.output_id}));
 }finally{f.store.close();}
 const g=setup();try {const job=g.output.card(g.alice,g.card('expired'));g.advance(3600001);await g.output.pumpOne();assert.equal(g.calls.length,0);assert.equal(g.store.db.prepare('SELECT state FROM output_outbox WHERE id=?').get(job.output_id)!.state,'cancelled');}finally{g.store.close();}
});
test('restart turns sending into uncertain, retains metadata and never replays even a prior PATCH',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'bridge-output-')),path=join(dir,'synthetic.sqlite'),f=setup(path);
 try {
 const job=f.output.card(f.alice,f.card('crash'));f.store.db.prepare("UPDATE output_outbox SET state='sending',phase='sending_card',attempts=1 WHERE id=?").run(job.output_id);f.store.close();
 const reopened=new Store(path);try {assert.equal(reopened.db.prepare('PRAGMA user_version').get()!.user_version,5);const r=reopened.db.prepare('SELECT * FROM output_outbox').get()!;assert.equal(r.state,'uncertain');assert.equal(r.payload,'');assert.equal(r.failure,'restart_during_send');}finally{reopened.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('disabled media is absent from MCP discovery and direct calls fail closed',async()=>{
 const f=fixture();f.bind();try {
 assert.throws(()=>f.bridge.output.chunk(f.alice,{}),code('image_output_disabled'));
 const app=makeApp({authMode:'oauth',publicUrl:'https://mock.invalid',issuer:'https://idp.invalid',apps:[],allowedOrigins:[]},f.bridge,{async authenticate(){return f.alice;}});
 const response=await app(new Request('https://mock.invalid/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','MCP-Protocol-Version':'2026-07-28','Mcp-Method':'tools/list'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'SYNTHETIC',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}}})}));
 const body=await response.json();assert.equal(body.result.tools.some((t:{name:string})=>t.name==='stage_generated_image_chunk'),false);assert.equal(body.result.tools.some((t:{name:string})=>t.name==='submit_feishu_status'),true);
 }finally{f.store.close();}
});
test('schema4 migration preserves handling and reply evidence and introduces an empty output ledger',()=>{
 const dir=mkdtempSync(join(tmpdir(),'bridge-output-migrate-')),path=join(dir,'synthetic.sqlite'),f=fixture(path);
 try {
 f.bind();f.bridge.receive(f.message());const before=f.store.db.prepare('SELECT * FROM event_handling').all();
 f.store.db.exec('DROP TABLE output_chunks; DROP TABLE output_media; DROP TABLE output_outbox; PRAGMA user_version=4');f.store.close();
 const upgraded=new Store(path);try{assert.equal(upgraded.db.prepare('PRAGMA user_version').get()!.user_version,5);assert.deepEqual(upgraded.db.prepare('SELECT * FROM event_handling').all(),before);assert.equal(upgraded.db.prepare('SELECT COUNT(*) AS n FROM output_outbox').get()!.n,0);}finally{upgraded.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('accepted card receipt persistence failure stays uncertain without a second network attempt',async()=>{
 const f=setup();try {
 const job=f.output.card(f.alice,f.card('receipt_write'));f.store.db.exec("CREATE TRIGGER MOCK_fail_output_receipt BEFORE UPDATE ON output_outbox WHEN NEW.state='sent' BEGIN SELECT RAISE(ABORT,'MOCK_only'); END");
 await f.output.pumpOne();assert.equal(f.output.status(f.alice,{output_id:job.output_id}).state,'uncertain');assert.equal(f.calls.length,1);await f.output.pumpOne();assert.equal(f.calls.length,1);
 }finally{f.store.close();}
});
test('binding changes during decode prevent upload and do not redirect bytes',async()=>{
 const f=setup();try {
 const out=new OutputDelivery(f.bridge,new SecretBox(f.storageKey),f.sender,f.now,async(bytes)=>{f.bridge.unlink(f.alice);return {bytes:Buffer.from(bytes)};},true);
 const stage=out.chunk(f.alice,f.chunk(await png())),job=out.image(f.alice,f.send(stage.transfer_id));await out.pumpOne();assert.equal(f.calls.length,0);assert.equal(f.store.db.prepare('SELECT state FROM output_outbox WHERE id=?').get(job.output_id)!.state,'failed');
 }finally{f.store.close();}
});
test('standard bridge worker pumps explicit status alongside original event/reply handling',async()=>{
 const f=setup();try {
 const event=f.bridge.receive(f.message());assert.equal(event.state,'accepted');
 const job=f.bridge.output.card(f.alice,f.card('worker'));await f.bridge.pump();assert.equal(f.bridge.output.status(f.alice,{output_id:job.output_id}).state,'sent');
 const ledger=f.store.db.prepare('SELECT state FROM event_handling').get()!;assert.equal(ledger.state,'awaiting_processing');
 }finally{f.store.close();}
});
test('runtime schema5 matches the exact offline maintenance schema',async()=>{
 const {DatabaseSync}=await import('node:sqlite'),{schema5}=await import('../scripts/maintenance-schema.js');const f=fixture(),reference=new DatabaseSync(':memory:');
 const description=(db:any)=>JSON.stringify(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name").all().map((r:any)=>({...r,sql:String(r.sql).replace(/\bIF NOT EXISTS\s+/gi,'').replace(/\s+/g,' ').trim()})));
 try {reference.exec(schema5);assert.equal(description(f.store.db),description(reference));}finally{reference.close();f.store.close();}
});

test('unlink closes staged tombstones and immediately releases quota for a new binding',async()=>{
 const f=setup();try {
 const bytes=await png(),old=f.output.chunk(f.alice,f.chunk(bytes,'old_one'));
 f.output.chunk(f.alice,f.chunk(bytes,'old_two'));
 assert.throws(()=>f.output.chunk(f.alice,f.chunk(bytes,'old_three')),code('image_staging_capacity'));
 f.bridge.unlink(f.alice);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM output_media WHERE consumed=0').get()!.n,0);
 const binding=f.bind();assert.notEqual(binding.id,f.binding.id);
 for(const source of ['new_one','new_two']) f.output.chunk(f.alice,f.chunk(bytes,source,{binding_id:binding.id}));
 assert.throws(()=>f.output.image(f.alice,{...f.send(old.transfer_id),binding_id:binding.id}),code('image_transfer_unavailable'));
 assert.equal(f.calls.length,0);
 }finally{f.store.close();}
});
test('cleanup closes inactive, revoked and expired staging records without discarding deduplication',async()=>{
 const f=setup();try {
 const bytes=await png(),stage=f.output.chunk(f.alice,f.chunk(bytes));
 f.store.db.prepare('UPDATE bindings SET active=0 WHERE id=?').run(f.binding.id);
 f.output.cleanup();assert.equal(f.store.db.prepare('SELECT consumed FROM output_media WHERE id=?').get(stage.transfer_id)!.consumed,1);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM output_chunks').get()!.n,0);
 const binding=f.bind();f.output.chunk(f.alice,f.chunk(bytes,'new',{binding_id:binding.id}));
 f.advance(16*60000);f.output.cleanup();assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM output_media WHERE consumed=0').get()!.n,0);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM output_media').get()!.n,2);
 }finally{f.store.close();}
 const g=setup();try {g.output.chunk(g.alice,g.chunk(await png()));g.store.revoke(g.alice.id);assert.equal(g.store.db.prepare('SELECT consumed FROM output_media').get()!.consumed,1);assert.equal(g.store.db.prepare('SELECT COUNT(*) AS n FROM output_chunks').get()!.n,0);}finally{g.store.close();}
});
test('cleanup, unlink and revoke roll back media closure when chunk deletion fails',async()=>{
 for(const action of ['cleanup','unlink','revoke'] as const) {
 const f=setup();try {
 f.output.chunk(f.alice,f.chunk(await png()));
 f.store.db.exec("CREATE TRIGGER MOCK_fail_chunk_delete BEFORE DELETE ON output_chunks BEGIN SELECT RAISE(ABORT,'MOCK_delete'); END");
 if(action==='cleanup') f.advance(16*60000);
 assert.throws(()=>action==='cleanup'?f.output.cleanup():action==='unlink'?f.bridge.unlink(f.alice):f.store.revoke(f.alice.id));
 assert.equal(f.store.db.prepare('SELECT consumed FROM output_media').get()!.consumed,0);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM output_chunks').get()!.n,1);
 assert.equal(f.store.binding(f.alice.id)!.id,f.binding.id);assert.equal(f.store.isRevoked(f.alice.id),false);
 f.store.db.exec('DROP TRIGGER MOCK_fail_chunk_delete');
 if(action==='cleanup') f.output.cleanup();else if(action==='unlink')f.bridge.unlink(f.alice);else f.store.revoke(f.alice.id);
 assert.equal(f.store.db.prepare('SELECT consumed FROM output_media').get()!.consumed,1);
 }finally{f.store.close();}
 }
});
test('image reservation rolls back payload, consumption and quota if chunk deletion fails',async()=>{
 const f=setup();try {
 const stage=f.output.chunk(f.alice,f.chunk(await png()));
 f.store.db.exec("CREATE TRIGGER MOCK_fail_reservation BEFORE DELETE ON output_chunks BEGIN SELECT RAISE(ABORT,'MOCK_delete'); END");
 assert.throws(()=>f.output.image(f.alice,f.send(stage.transfer_id)));
 assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM output_outbox').get()!.n,0);
 assert.equal(f.store.db.prepare('SELECT consumed FROM output_media').get()!.consumed,0);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM output_chunks').get()!.n,1);
 f.store.db.exec('DROP TRIGGER MOCK_fail_reservation');
 const job=f.output.image(f.alice,f.send(stage.transfer_id));await f.output.pumpOne();assert.equal(f.output.status(f.alice,{output_id:job.output_id}).state,'sent');assert.equal(f.calls.length,2);
 }finally{f.store.close();}
});
test('double receipt persistence failures never retry card create, PATCH or image upload and recover uncertain',async()=>{
 for(const kind of ['card','patch','image'] as const) {
 const dir=mkdtempSync(join(tmpdir(),'bridge-output-double-fault-')),path=join(dir,'synthetic.sqlite'),f=setup(path);
 try {
 let job;
 if(kind==='image'){const stage=f.output.chunk(f.alice,f.chunk(await png()));job=f.output.image(f.alice,f.send(stage.transfer_id));}
 else {if(kind==='patch'){f.output.card(f.alice,f.card('initial'));await f.output.pumpOne();}job=f.output.card(f.alice,f.card('fault',kind==='patch'?1:0));}
 const before=f.calls.length;
 // Fault persists through both receipt and fallback writes, then is removed before recovery.
 f.store.db.exec(`CREATE TRIGGER MOCK_double_write BEFORE UPDATE ON output_outbox WHEN NEW.state='uncertain' OR ${kind==='image'?"NEW.phase='uploaded'":"NEW.state='sent'"} BEGIN SELECT RAISE(ABORT,'MOCK_write'); END`);
 await assert.rejects(f.output.pumpOne());
 const row=f.store.db.prepare('SELECT state,attempts FROM output_outbox WHERE id=?').get(job.output_id)!;
 assert.equal(row.state,'sending');assert.equal(row.attempts,1);assert.equal(f.calls.length,before+1);
 await f.output.pumpOne();assert.equal(f.calls.length,before+1);
 f.store.db.exec('DROP TRIGGER MOCK_double_write');f.store.close();
 const reopened=setup(path);try {
 assert.equal(reopened.store.db.prepare('SELECT state,payload FROM output_outbox WHERE id=?').get(job.output_id)!.state,'uncertain');
 assert.equal(reopened.store.db.prepare('SELECT payload FROM output_outbox WHERE id=?').get(job.output_id)!.payload,'');
 await reopened.output.pumpOne();assert.equal(reopened.calls.length,0);
 }finally{reopened.store.close();}
 }finally{try{f.store.close();}catch{}rmSync(dir,{recursive:true,force:true});}
 }
});
