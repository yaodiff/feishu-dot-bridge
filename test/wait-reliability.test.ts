/** Synthetic waits, pixels, messages and transports only. No native approval is created. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {fixture,mockApp} from './fixtures.js';
import {hash,SecretBox} from '../src/crypto.js';
import {Bridge} from '../src/bridge.js';
import {Store} from '../src/store.js';
import {buildStatusCard,DOT_ENTRY} from '../src/status-card.js';
import {eventWaitId} from '../src/output.js';
import {makeApp} from '../src/http.js';
const notice={summary:'MOCK 已观察到任务需要确认',action:'检查合成任务请求',reason:'合成外部动作需确认',existing_user_authorization:true as const};
function setup(path=':memory:'){
 const f=fixture(path),binding=f.bind(),cards:{card:unknown,message?:string}[]=[];
 f.sender.sendCard=async(_app,_chat,card)=>{cards.push({card});return 'om_MOCK_notice_'+cards.length;};
 f.sender.patchCard=async(_app,message,card)=>{cards.push({card,message});};
 const m=f.message({messageId:'om_MOCK_wait',text:'MOCK harmless input'});f.bridge.receive(m);
 const event='evt_'+hash(JSON.stringify([m.appId,m.tenantKey,m.messageId]));
 const claimed=f.bridge.handling.claim(f.alice,{event_id:event,request_id:'MOCK_claim',revision:0});
 const decision={event_id:event,revision:claimed.revision,outcome:'waiting_authorization' as const,notice};
 const status=()=>f.bridge.handling.status(f.alice,{event_id:event});
 const outputCount=()=>Number(f.store.db.prepare('SELECT COUNT(*) AS n FROM output_outbox').get()!.n);
 return {...f,binding,event,claimed,decision,status,outputCount,cards};
}
test('one observed-wait call atomically persists handling and one deduplicated important card, with receipt metadata',async()=>{
 const f=setup();try{
 const r=f.bridge.handling.complete(f.alice,f.decision);assert.equal(r.handling_state,'waiting_authorization');assert.equal(r.waiting_notification!.state,'pending');assert.equal(r.waiting_notification!.api_accepted,false);assert.equal(f.cards.length,0);
 assert.equal(f.bridge.handling.complete(f.alice,f.decision).waiting_notification!.state,'pending');assert.equal(f.outputCount(),1);
 await f.bridge.pump();const sent=f.status().waiting_notification!;assert.equal(sent.state,'sent');assert.equal(sent.api_accepted,true);assert.equal('initial_notice_api_accepted' in sent && sent.initial_notice_api_accepted,true);assert.equal(f.cards.length,1);assert.equal(f.status().reply_state,'not_queued');
 assert.equal(f.bridge.handling.complete(f.alice,f.decision).waiting_notification!.state,'sent');await f.bridge.pump();assert.equal(f.cards.length,1);
 assert.throws(()=>f.bridge.handling.complete(f.alice,{...f.decision,notice:{...notice,action:'different'}}),/output_request_conflict/);assert.equal(f.outputCount(),1);
 }finally{f.store.close();}
});
for(const target of ['output','handling'] as const)test('atomic wait and notification roll back together on '+target+' persistence failure',()=>{
 const f=setup();try{
 f.store.db.exec(target==='output'?"CREATE TRIGGER MOCK_fault BEFORE INSERT ON output_outbox BEGIN SELECT RAISE(ABORT,'MOCK_FAILURE'); END":"CREATE TRIGGER MOCK_fault BEFORE UPDATE ON event_handling BEGIN SELECT RAISE(ABORT,'MOCK_FAILURE'); END");
 assert.throws(()=>f.bridge.handling.complete(f.alice,f.decision),/MOCK_FAILURE/);assert.equal(f.status().handling_state,'processing');assert.equal(f.status().revision,f.claimed.revision);assert.equal(f.outputCount(),0);assert.equal(f.cards.length,0);
 f.store.db.exec('DROP TRIGGER MOCK_fault');assert.equal(f.bridge.handling.complete(f.alice,f.decision).waiting_notification!.state,'pending');
 }finally{f.store.close();}
});
test('missing or prohibited notification stays visibly not_submitted; recording a wait never invents send authority',()=>{
 const f=setup();try{
 const {notice:_notice,...without}=f.decision;const r=f.bridge.handling.complete(f.alice,without);assert.equal(r.waiting_notification!.state,'not_submitted');assert.equal(r.waiting_notification!.requires_attention,true);assert.equal(f.outputCount(),0);
 assert.throws(()=>f.bridge.handling.complete(f.alice,{...f.decision,notice:{...notice,existing_user_authorization:false}}));
 assert.throws(()=>f.bridge.handling.complete(f.alice,{...f.decision,notice:{...notice,request_id:'force_replay'}}));assert.equal(f.outputCount(),0);
 assert.equal(f.bridge.handling.alerts(f.alice,{}).alerts[0]!.waiting_notification!.state,'not_submitted');
 }finally{f.store.close();}
});
test('wait notice fails closed for stale/expired lease, credential content, foreign owner and changed binding',()=>{
 const f=setup();try{
 assert.throws(()=>f.bridge.handling.complete(f.bob,f.decision));assert.throws(()=>f.bridge.handling.complete(f.alice,{...f.decision,revision:0}),/handling_revision_conflict/);
 assert.throws(()=>f.bridge.handling.complete(f.alice,{...f.decision,notice:{...notice,summary:'Bearer abcdefghijklmnopqrstuvwxyz123456'}}),/credential_blocked/);assert.equal(f.outputCount(),0);assert.equal(f.status().handling_state,'processing');
 f.advance(60001);assert.throws(()=>f.bridge.handling.complete(f.alice,f.decision),/handling_lease_expired/);assert.equal(f.outputCount(),0);
 f.bridge.unlink(f.alice);f.bind();assert.throws(()=>f.bridge.handling.complete(f.alice,f.decision),/event_not_found/);assert.equal(f.outputCount(),0);
 }finally{f.store.close();}
});
for(const mode of ['pending','uncertain'] as const)test('restart keeps recorded wait; '+mode+' notices follow reservation recovery without duplicate network calls',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'MOCK-wait-restart-')),path=join(dir,'db.sqlite'),f=setup(path);let reopened:Store|undefined;
 try{
 const r=f.bridge.handling.complete(f.alice,f.decision),id='output_id' in r.waiting_notification! ? r.waiting_notification.output_id : undefined;assert.ok(id);
 if(mode==='uncertain'){
  f.sender.sendCard=async()=>{f.cards.push({card:'MOCK ambiguous acceptance'});throw new Error('MOCK transport interrupted');};await f.bridge.pump();assert.equal(f.status().waiting_notification!.state,'uncertain');
 }
 f.store.close();reopened=new Store(path);const bridge=new Bridge(reopened,new SecretBox(f.storageKey),f.transport,f.sender,f.now);
 const before=f.cards.length;const retried=bridge.handling.complete(f.alice,f.decision);assert.equal(retried.waiting_notification!.state,mode);await bridge.pump();
 assert.equal(f.cards.length,before+(mode==='pending'?1:0));const after=bridge.handling.status(f.alice,{event_id:f.event});assert.equal(after.waiting_notification!.state,mode==='pending'?'sent':'uncertain');assert.equal(after.handling_state,'waiting_authorization');
 assert.throws(()=>bridge.handling.claim(f.alice,{event_id:f.event,request_id:'MOCK_unapproved',revision:after.revision}),/handling_authorization_required/);
 await bridge.pump();assert.equal(f.cards.length,before+(mode==='pending'?1:0));
 }finally{try{reopened?.close();}finally{try{f.store.close();}catch{}rmSync(dir,{recursive:true,force:true});}}
});
test('interrupted sending wait becomes uncertain at restart, while caller retry cannot invent a new notice identity',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'MOCK-wait-inflight-')),path=join(dir,'db.sqlite'),f=setup(path);let s:Store|undefined;
 try{
 f.bridge.handling.complete(f.alice,f.decision);f.store.db.exec("UPDATE output_outbox SET state='sending',phase='sending_card',attempts=1");f.store.close();s=new Store(path);
 const b=new Bridge(s,new SecretBox(f.storageKey),f.transport,f.sender,f.now);const r=b.handling.complete(f.alice,f.decision);assert.equal(r.waiting_notification!.state,'uncertain');await b.pump();assert.equal(f.cards.length,0);
 assert.throws(()=>b.output.card(f.alice,{...notice,binding_id:f.binding.id,request_id:'MOCK_new',task_id:eventWaitId(f.event,f.claimed.revision),expected_revision:1,status:'waiting_confirmation'}),/reserved_status_identity/);
 assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM output_outbox').get()!.n,1);
 }finally{s?.close();try{f.store.close();}catch{}rmSync(dir,{recursive:true,force:true});}
});
test('real caller-reported resume may explicitly PATCH the accepted wait card; a card never grants or clears approval',async()=>{
 const f=setup();try{
 const first=f.bridge.handling.complete(f.alice,f.decision);await f.bridge.pump();const n=f.status().waiting_notification!;assert.ok('task_id' in n);assert.equal(f.status().handling_state,'waiting_authorization');
 const resumed=f.bridge.handling.claim(f.alice,{event_id:f.event,request_id:'MOCK_actual_caller_assertion',revision:first.revision,resume_waiting:'existing_user_authorization'});assert.equal(f.cards.length,1);
 const next=f.bridge.output.card(f.alice,{binding_id:f.binding.id,request_id:'MOCK_resume_notice',task_id:n.task_id,expected_revision:n.revision,status:'processing',summary:'MOCK caller reports work resumed',existing_user_authorization:true});await f.bridge.pump();assert.equal(f.bridge.output.status(f.alice,{output_id:next.output_id}).state,'sent');assert.ok(f.cards[1]!.message);assert.equal(f.status().revision,resumed.revision);assert.equal(f.status().handling_state,'processing');
 }finally{f.store.close();}
});
test('pre-action notice is truthful prospective processing, uses navigation only and sends before any protected action',async()=>{
 const f=setup();try{
 const a={binding_id:f.binding.id,task_id:'MOCK_preflight',request_id:'MOCK_preflight_start',expected_revision:0,status:'processing' as const,summary:'MOCK preparing an external action',action:'MOCK attempt upload',reason:'MOCK may require native confirmation',confirmation_notice:'before_action' as const,existing_user_authorization:true as const};
 const card=buildStatusCard(a),raw=JSON.stringify(card);assert.match(card.header.title.content,/行动前提示/);assert.match(raw,/不表示已有审批请求/);assert.ok(raw.includes(DOT_ENTRY));assert.ok(!raw.includes('callback'));assert.match(raw,/不授予 dot 权限/);
 const pending=f.bridge.output.card(f.alice,a);assert.equal(pending.api_accepted,false);assert.equal(f.status().handling_state,'processing');await f.bridge.pump();assert.equal(f.bridge.output.status(f.alice,{output_id:pending.output_id}).api_accepted,true);assert.equal(f.status().handling_state,'processing');
 assert.throws(()=>f.bridge.output.card(f.alice,{...a,status:'waiting_confirmation'}));assert.throws(()=>f.bridge.output.card(f.alice,{...a,action:undefined}));
 const ordinary=f.bridge.output.card(f.alice,{...a,request_id:'MOCK_normal',expected_revision:1,confirmation_notice:undefined});await f.bridge.pump();
 const important=f.bridge.output.card(f.alice,{...a,request_id:'MOCK_preflight_second',expected_revision:2});await f.bridge.pump();assert.equal(f.bridge.output.status(f.alice,{output_id:ordinary.output_id}).message_id,pending.message_id??f.cards[1]!.message);assert.notEqual(f.bridge.output.status(f.alice,{output_id:important.output_id}).message_id,f.cards[1]!.message);
 }finally{f.store.close();}
});
test('protected MCP exposes opt-in atomic notice schema without inventing platform approval events or new tools',async()=>{
 const f=setup();try{
 const app=makeApp({authMode:'oauth',publicUrl:'http://127.0.0.1',issuer:'https://MOCK.invalid',apps:[mockApp],allowedOrigins:[]},f.bridge,{async authenticate(){return f.alice;}});
 async function rpc(method:string,params:Record<string,unknown>){const response=await app(new Request('http://127.0.0.1/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json,text/event-stream','MCP-Protocol-Version':'2026-07-28','Mcp-Method':method,...(params.name?{'Mcp-Name':String(params.name)}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:{...params,_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'MOCK',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}}})}));return (await response.json()).result;}
 const list=await rpc('tools/list',{});assert.equal(list.tools.length,16);const complete=list.tools.find((x:{name:string})=>x.name==='complete_event_handling');assert.match(JSON.stringify(complete.inputSchema),/notice/);assert.equal(complete.annotations.openWorldHint,true);
 const result=await rpc('tools/call',{name:'complete_event_handling',arguments:f.decision});assert.equal(JSON.parse(result.content[0].text).waiting_notification.state,'pending');
 const events=await rpc('events/list',{});assert.deepEqual(events.events.map((e:{name:string})=>e.name),['feishu.message.created']);
 }finally{f.store.close();}
});
test('Linux stability scenario: callback interruption, restart recovery, real PNG decode, text reply and card PATCH remain independent', {skip:process.platform!=='linux'},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'MOCK-wait-stability-')),path=join(dir,'db.sqlite'),f=fixture(path);let s:Store|undefined;
 try{
 const binding=f.bind();let failed=false;const original=f.transport.post.bind(f.transport);
 f.transport.post=async(url,body,headers)=>{const result=await original(url,body,headers);if(JSON.parse(body).type!=='verification'&&!failed){failed=true;return{status:503,body:'MOCK temporary interruption'};}return result;};
 await f.subscribe();const m=f.message({messageId:'om_MOCK_stability',text:'MOCK current synthetic request'});f.bridge.receive(m);const event='evt_'+hash(JSON.stringify([m.appId,m.tenantKey,m.messageId]));await f.bridge.pump();assert.equal(f.bridge.handling.status(f.alice,{event_id:event}).callback_accepted,false);
 f.store.close();s=new Store(path);f.advance(60000);const calls:{kind:string,bytes?:Buffer}[]=[];
 f.sender.reply=async()=>{calls.push({kind:'reply'});return{messageId:'om_MOCK_reply'};};f.sender.sendCard=async()=>{calls.push({kind:'card'});return'om_MOCK_card';};f.sender.patchCard=async()=>{calls.push({kind:'patch'});};f.sender.uploadImage=async(_app,bytes)=>{calls.push({kind:'upload',bytes:Buffer.from(bytes)});return'img_MOCK_generated';};f.sender.sendImage=async()=>{calls.push({kind:'image'});return'om_MOCK_image';};
 const b=new Bridge(s,new SecretBox(f.storageKey),f.transport,f.sender,f.now,undefined,undefined,{images:true});await b.pump();assert.equal(b.handling.status(f.alice,{event_id:event}).callback_accepted,true);const eventBodies=f.calls.filter(c=>c.body.type!=='verification');assert.equal(eventBodies.length,2);assert.equal(eventBodies[0]!.body.eventId,eventBodies[1]!.body.eventId);
 const c=b.handling.claim(f.alice,{event_id:event,request_id:'MOCK_stability_claim',revision:0});const wait=b.handling.complete(f.alice,{event_id:event,revision:c.revision,outcome:'waiting_authorization',notice});await b.pump();const sent=b.handling.status(f.alice,{event_id:event}).waiting_notification!;assert.equal(sent.state,'sent');assert.ok('task_id'in sent);
 const resume=b.handling.claim(f.alice,{event_id:event,request_id:'MOCK_stability_resume',revision:wait.revision,resume_waiting:'existing_user_authorization'});b.reply(f.alice,{event_id:event,text:'MOCK real synthetic answer',handling_revision:resume.revision});
 const bytes=await sharp({create:{width:18,height:12,channels:4,background:'#369aff'}}).png().toBuffer();const media=b.output.chunk(f.alice,{binding_id:binding.id,source_message_id:'MOCK_new_generated',sha256:createHash('sha256').update(bytes).digest('hex'),mime_type:'image/png',generated_at:new Date(f.now()).toISOString(),source:'current_generated_image',existing_user_authorization:true,chunk_index:0,total_chunks:1,chunk_base64:bytes.toString('base64')});const image=b.output.image(f.alice,{binding_id:binding.id,transfer_id:media.transfer_id,request_id:'MOCK_stability_image',existing_user_authorization:true});
 const done=b.output.card(f.alice,{binding_id:binding.id,task_id:sent.task_id,request_id:'MOCK_stability_done',expected_revision:sent.revision,status:'completed',summary:'MOCK completed',existing_user_authorization:true});await b.pump();
 assert.equal(b.deliveryStatus(f.alice,event).state,'sent');assert.equal(b.output.status(f.alice,{output_id:image.output_id}).upload_accepted,true);assert.equal(b.output.status(f.alice,{output_id:image.output_id}).state,'sent');assert.equal(b.output.status(f.alice,{output_id:done.output_id}).state,'sent');const metadata=await sharp(calls.find(x=>x.kind==='upload')!.bytes!).metadata();assert.equal(metadata.width,18);assert.equal(metadata.format,'png');
 const before=calls.length;await b.pump();assert.equal(calls.length,before);assert.equal(b.output.alerts(f.alice,{}).outputs.length,0);assert.equal(b.handling.alerts(f.alice,{}).alerts.length,0);
 }finally{s?.close();try{f.store.close();}catch{}rmSync(dir,{recursive:true,force:true});}
});
test('known notice rejection stays linked and alerted without another attempt on caller retry or pump',async()=>{
 const f=setup();try{
 const {BridgeError}=await import('../src/types.js');let attempts=0;f.sender.sendCard=async()=>{attempts++;throw new BridgeError('feishu_output_rejected');};
 f.bridge.handling.complete(f.alice,f.decision);await f.bridge.pump();const r=f.status();assert.equal(r.handling_state,'waiting_authorization');assert.equal(r.waiting_notification!.state,'failed');assert.equal(r.waiting_notification!.requires_attention,true);
 f.bridge.handling.complete(f.alice,f.decision);await f.bridge.pump();assert.equal(attempts,1);assert.equal(f.bridge.output.alerts(f.alice,{}).outputs[0]!.state,'failed');assert.equal(f.outputCount(),1);
 }finally{f.store.close();}
});
test('reserved event notice identities cannot be forged by a public card or image request',()=>{
 const f=setup();try{
 const identity=eventWaitId(f.event,f.claimed.revision),ordinary={binding_id:f.binding.id,task_id:identity,request_id:'MOCK_forge',expected_revision:0,status:'processing',summary:'MOCK fake relationship',existing_user_authorization:true};
 assert.throws(()=>f.bridge.output.card(f.alice,ordinary),/reserved_status_identity/);assert.throws(()=>f.bridge.output.card(f.alice,{...ordinary,task_id:'MOCK_normal',request_id:identity}),/reserved_status_identity/);
 const b=new Bridge(f.store,new SecretBox(f.storageKey),f.transport,f.sender,f.now,undefined,undefined,{images:true});assert.throws(()=>b.output.image(f.alice,{binding_id:f.binding.id,transfer_id:'MOCK_transfer',request_id:identity,existing_user_authorization:true}),/reserved_status_identity/);assert.equal(f.outputCount(),0);
 }finally{f.store.close();}
});
