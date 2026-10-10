/** Synthetic events only. No real callbacks, account permissions or runtime DB. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture, mockApp } from './fixtures.js';
import { hash, SecretBox } from '../src/crypto.js';
import { Bridge } from '../src/bridge.js';
import { Store } from '../src/store.js';
import { makeApp } from '../src/http.js';
import { runMaintenance } from '../scripts/maintenance.js';

function incoming(f:ReturnType<typeof fixture>, n='one') {
  const m=f.message({messageId:'om_MOCK_'+n,text:'MOCK_PRIVATE_BODY'});
  f.bridge.receive(m);return 'evt_'+hash(JSON.stringify([m.appId,m.tenantKey,m.messageId]));
}
function status(f:ReturnType<typeof fixture>,id:string){return f.bridge.handling.status(f.alice,{event_id:id});}
function claim(f:ReturnType<typeof fixture>,id:string,request='MOCK_task',lease=60000){return f.bridge.handling.claim(f.alice,{event_id:id,request_id:request,revision:status(f,id).revision,lease_ms:lease});}

test('callback success without reply reservation becomes a metadata-only gap alert; no automatic answer or wake',async()=>{
  const f=fixture();try{
    f.bind();await f.subscribe();const id=incoming(f);await f.bridge.pump();
    assert.equal(status(f,id).callback_accepted,true);assert.equal(status(f,id).reply_state,'not_queued');
    f.advance(120001);const alerts=f.bridge.handling.alerts(f.alice,{});
    assert.equal(alerts.alerts[0]!.alert,'callback_delivered_without_reply');
    assert.doesNotMatch(JSON.stringify(alerts),/MOCK_PRIVATE_BODY|ou_alice|oc_alice|whsec_/);
    const calls=f.calls.length;await f.bridge.pump();assert.equal(f.calls.length,calls);assert.equal(f.sent.length,0);
    assert.equal(f.bridge.listPendingEvents(f.alice,{}).events[0]!.event_id,id);
  }finally{f.store.close();}
});
test('claim has bounded lease, live exclusion, revision fencing and idempotent retry without lease renewal',()=>{
  const f=fixture();try{
    f.bind();const id=incoming(f),a=claim(f,id,'MOCK_first',1000);
    f.advance(500);const retry=f.bridge.handling.claim(f.alice,{event_id:id,request_id:'MOCK_first',revision:0,lease_ms:300000});
    assert.equal(retry.revision,a.revision);assert.equal(retry.lease_until,a.lease_until);
    assert.throws(()=>claim(f,id,'MOCK_second'),/handling_busy/);
    assert.throws(()=>f.bridge.reply(f.alice,{event_id:id,text:'MOCK',handling_revision:0}),/handling_revision_conflict/);
    f.advance(501);assert.equal(status(f,id).alert,'processing_lease_expired');
    assert.throws(()=>f.bridge.reply(f.alice,{event_id:id,text:'MOCK',handling_revision:a.revision}),/handling_lease_expired/);
    const b=claim(f,id,'MOCK_recovery');assert.ok(b.revision>a.revision);
    assert.throws(()=>f.bridge.handling.complete(f.alice,{event_id:id,revision:a.revision,outcome:'no_reply',reason:'no_response_needed'}),/handling_revision_conflict/);
    assert.equal(f.sent.length,0);assert.equal(f.bridge.store.job('reply_'+hash(id)),undefined);
  }finally{f.store.close();}
});
test('waiting authorization cannot be automatically reclaimed or replied; explicit approved resume still does not send',async()=>{
  const f=fixture();try{
    f.bind();const id=incoming(f),a=claim(f,id);
    const decision={event_id:id,revision:a.revision,outcome:'waiting_authorization'};
    const completed=f.bridge.handling.complete(f.alice,decision);
    assert.deepEqual(f.bridge.handling.complete(f.alice,decision),completed);
    f.advance(300000);assert.equal(status(f,id).alert,'authorization_required');
    assert.throws(()=>claim(f,id,'MOCK_retry'),/handling_authorization_required/);
    assert.throws(()=>f.bridge.reply(f.alice,{event_id:id,text:'MOCK'}),/handling_reply_prohibited/);
    const resumed=f.bridge.handling.claim(f.alice,{event_id:id,request_id:'MOCK_approved',revision:completed.revision,resume_waiting:'existing_user_authorization'});
    assert.equal(f.sent.length,0);
    f.bridge.reply(f.alice,{event_id:id,text:'MOCK_APPROVED',handling_revision:resumed.revision});await f.bridge.pump();
    assert.equal(status(f,id).reply_state,'sent');assert.equal(f.sent.length,1);
  }finally{f.store.close();}
});
for(const reason of ['sending_prohibited','no_response_needed'] as const)test('explicit no_reply '+reason+' is terminal and never converted to an automatic answer',async()=>{
  const f=fixture();try{
    f.bind();const id=incoming(f),a=claim(f,id);
    f.bridge.handling.complete(f.alice,{event_id:id,revision:a.revision,outcome:'no_reply',reason});
    assert.throws(()=>f.bridge.reply(f.alice,{event_id:id,text:'MOCK'}),/handling_reply_prohibited/);
    assert.throws(()=>f.bridge.handling.claim(f.alice,{event_id:id,request_id:'MOCK_override',revision:status(f,id).revision,resume_waiting:'existing_user_authorization'}),/handling_terminal/);
    f.advance(300000);assert.equal(status(f,id).alert,undefined);await f.bridge.pump();assert.equal(f.sent.length,0);
    assert.equal(status(f,id).reply_state,'not_queued');
  }finally{f.store.close();}
});
test('merged inputs are individually fenced and covered only by an actual accepted direct reply',async()=>{
  const f=fixture();try{
    f.bind();const a=incoming(f,'a'),b=incoming(f,'b'),c=incoming(f,'c');
    const ca=claim(f,a,'MOCK_a'),cb=claim(f,b,'MOCK_b'),cc=claim(f,c,'MOCK_c');
    f.bridge.reply(f.alice,{event_id:a,text:'MOCK_COMBINED_ANSWER',handling_revision:ca.revision});
    const cover={event_id:b,revision:cb.revision,outcome:'covered_by_reply',covering_event_id:a};
    assert.throws(()=>f.bridge.handling.complete(f.alice,cover),/covering_reply_not_sent/);
    await f.bridge.pump();const covered=f.bridge.handling.complete(f.alice,cover);
    assert.deepEqual(f.bridge.handling.complete(f.alice,cover),covered);
    f.bridge.handling.complete(f.alice,{event_id:c,revision:cc.revision,outcome:'covered_by_reply',covering_event_id:a});
    assert.equal(covered.handling_state,'covered_by_reply');assert.equal(covered.reply_state_applies_to,a);
    assert.equal(f.bridge.deliveryStatus(f.alice,b).state,'not_queued');assert.equal(f.sent.length,1);
    assert.throws(()=>f.bridge.reply(f.alice,{event_id:b,text:'MOCK_DUPLICATE'}),/handling_reply_prohibited/);
    f.advance(300000);assert.equal(f.bridge.handling.alerts(f.alice,{}).alerts.length,0);
  }finally{f.store.close();}
});
test('dot-only output, self-reference, chained coverage and uncertain sends never close merged events',async()=>{
  const f=fixture();try{
    f.bind();const a=incoming(f,'a'),b=incoming(f,'b');const cb=claim(f,b);
    assert.throws(()=>f.bridge.handling.complete(f.alice,{event_id:b,revision:cb.revision,outcome:'covered_by_reply',covering_event_id:a}),/covering_reply_not_sent/);
    assert.throws(()=>f.bridge.handling.complete(f.alice,{event_id:b,revision:cb.revision,outcome:'covered_by_reply',covering_event_id:b}),/invalid_coverage/);
    f.bridge.reply(f.alice,{event_id:a,text:'MOCK'});f.store.db.prepare("UPDATE jobs SET state='uncertain' WHERE kind='reply'").run();
    assert.throws(()=>f.bridge.handling.complete(f.alice,{event_id:b,revision:cb.revision,outcome:'covered_by_reply',covering_event_id:a}),/covering_reply_not_sent/);
    assert.equal(status(f,a).alert,'delivery_requires_verification');await f.bridge.pump();assert.equal(f.sent.length,0);
  }finally{f.store.close();}
});
test('duplicate ingress keeps original handling decision and receipt reservation',()=>{
  const f=fixture();try{
    f.bind();const id=incoming(f),a=claim(f,id);f.bridge.handling.complete(f.alice,{event_id:id,revision:a.revision,outcome:'no_reply',reason:'sending_prohibited'});
    const before=status(f,id);incoming(f);assert.deepEqual(status(f,id),before);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM event_handling').get()!.n,1);
  }finally{f.store.close();}
});
test('owner, current binding, revocation and expired authorization are enforced on reads and mutations',()=>{
  const f=fixture();try{
    f.bind();const id=incoming(f);f.bind(f.bob,{openId:'ou_bob',chatId:'oc_bob'});
    assert.throws(()=>f.bridge.handling.status(f.bob,{event_id:id}),/event_not_found/);
    assert.throws(()=>f.bridge.handling.claim(f.bob,{event_id:id,request_id:'MOCK',revision:0}),/event_not_found/);
    assert.throws(()=>f.bridge.handling.status({...f.alice,expiresAt:f.now()},{event_id:id}),/unauthorized/);
    f.bridge.unlink(f.alice);f.bind(f.alice,{openId:'ou_new',chatId:'oc_new'});
    assert.throws(()=>status(f,id),/event_not_found/);assert.equal(f.bridge.handling.alerts(f.alice,{}).alerts.length,0);
    f.store.revoke(f.alice.id);assert.throws(()=>f.bridge.handling.alerts(f.alice,{}),/unauthorized/);
  }finally{f.store.close();}
});
test('lease completion and reply reservation are atomic on local storage failure',()=>{
  const f=fixture();try{
    f.bind();const id=incoming(f);f.store.db.exec("CREATE TRIGGER MOCK_fail_ledger BEFORE UPDATE ON event_handling BEGIN SELECT RAISE(ABORT,'MOCK_LEDGER_FAILURE'); END");
    assert.throws(()=>f.bridge.reply(f.alice,{event_id:id,text:'MOCK'}),/MOCK_LEDGER_FAILURE/);
    assert.equal(f.store.job('reply_'+hash(id)),undefined);assert.equal(status(f,id).handling_state,'awaiting_processing');
    f.store.db.exec('DROP TRIGGER MOCK_fail_ledger');const c=claim(f,id);
    f.store.db.exec("CREATE TRIGGER MOCK_fail_ledger BEFORE UPDATE ON event_handling BEGIN SELECT RAISE(ABORT,'MOCK_LEDGER_FAILURE'); END");
    assert.throws(()=>f.bridge.handling.complete(f.alice,{event_id:id,revision:c.revision,outcome:'no_reply',reason:'sending_prohibited'}),/MOCK_LEDGER_FAILURE/);
    assert.equal(status(f,id).handling_state,'processing');
  }finally{f.store.close();}
});
test('restart preserves processing/wait/no_reply/coverage and never replays sending or uncertain replies',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'MOCK-handling-restart-')),f=fixture(join(dir,'db.sqlite'));
  try{
    f.bind();const ids=['lease','wait','deny','sent','covered','sending','uncertain'].map(n=>incoming(f,n));
    const lease=claim(f,ids[0]!);const wait=claim(f,ids[1]!);f.bridge.handling.complete(f.alice,{event_id:ids[1],revision:wait.revision,outcome:'waiting_authorization'});
    const deny=claim(f,ids[2]!);f.bridge.handling.complete(f.alice,{event_id:ids[2],revision:deny.revision,outcome:'no_reply',reason:'sending_prohibited'});
    f.bridge.reply(f.alice,{event_id:ids[3],text:'MOCK'});await f.bridge.pump();const cover=claim(f,ids[4]!);
    f.bridge.handling.complete(f.alice,{event_id:ids[4],revision:cover.revision,outcome:'covered_by_reply',covering_event_id:ids[3]});
    for(const [i,state] of [[5,'sending'],[6,'uncertain']] as const){const q=f.bridge.reply(f.alice,{event_id:ids[i],text:'MOCK'});f.store.db.prepare('UPDATE jobs SET state=?,attempts=1 WHERE id=?').run(state,q.reply_id);}
    f.store.close();const store=new Store(join(dir,'db.sqlite'));try{
      const b=new Bridge(store,new SecretBox(f.storageKey),f.transport,f.sender,f.now);
      assert.equal(b.handling.status(f.alice,{event_id:ids[0]}).revision,lease.revision);
      assert.equal(b.handling.status(f.alice,{event_id:ids[1]}).handling_state,'waiting_authorization');
      assert.equal(b.handling.status(f.alice,{event_id:ids[2]}).handling_state,'no_reply');
      assert.equal(b.handling.status(f.alice,{event_id:ids[4]}).covering_event_id,ids[3]);
      await b.pump();assert.equal(f.sent.length,1);
      for(const i of [5,6])assert.equal(b.handling.status(f.alice,{event_id:ids[i]}).reply_state,'uncertain');
      f.advance(60001);assert.equal(b.handling.status(f.alice,{event_id:ids[0]}).alert,'processing_lease_expired');
    }finally{store.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('schema 3 upgrade seeds real reservations without inventing handling outcomes or replaying sends',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'MOCK-handling-migration-')),path=join(dir,'db.sqlite'),f=fixture(path);
  try{
    f.bind();const untouched=incoming(f,'untouched'),sent=incoming(f,'sent');f.bridge.reply(f.alice,{event_id:sent,text:'MOCK'});await f.bridge.pump();
    const before=f.store.db.prepare('SELECT * FROM jobs').all();f.store.db.exec('DROP TABLE event_handling;PRAGMA user_version=3');f.store.close();
    const s=new Store(path);try{
      assert.equal(s.db.prepare('PRAGMA user_version').get()!.user_version,5);assert.deepEqual(s.db.prepare('SELECT * FROM jobs').all(),before);
      const b=new Bridge(s,new SecretBox(f.storageKey),f.transport,f.sender,f.now);
      assert.equal(b.handling.status(f.alice,{event_id:untouched}).handling_state,'awaiting_processing');
      assert.equal(b.handling.status(f.alice,{event_id:sent}).handling_state,'reply_reserved');await b.pump();assert.equal(f.sent.length,1);
    }finally{s.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('schema 4 missing handling evidence fails closed at restart instead of reopening a prohibited event',()=>{
  const dir=mkdtempSync(join(tmpdir(),'MOCK-handling-missing-')),path=join(dir,'db.sqlite'),f=fixture(path);
  try{
    f.bind();const id=incoming(f),c=claim(f,id);
    f.bridge.handling.complete(f.alice,{event_id:id,revision:c.revision,outcome:'no_reply',reason:'sending_prohibited'});
    f.store.db.prepare('DELETE FROM event_handling WHERE eventId=?').run(id);f.store.close();
    assert.throws(()=>new Store(path),/Malformed event handling ledger/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('alerts paginate over empty pages; metadata remains inspectable after reply window, recovery refuses it',()=>{
  const f=fixture();try{
    f.bind();const one=incoming(f,'one'),two=incoming(f,'two');const c=claim(f,one);f.bridge.handling.complete(f.alice,{event_id:one,revision:c.revision,outcome:'no_reply',reason:'no_response_needed'});
    f.advance(120001);const page=f.bridge.handling.alerts(f.alice,{limit:1});assert.equal(page.alerts.length,0);assert.ok(page.next_after_seq);
    assert.equal(f.bridge.handling.alerts(f.alice,{limit:1,after_seq:page.next_after_seq}).alerts[0]!.event_id,two);
    f.advance(24*3600000);f.alice.expiresAt=f.now()+3600000;
    assert.equal(status(f,two).reply_state,'not_queued');assert.equal(status(f,two).recovery_available,false);assert.throws(()=>claim(f,two,'MOCK_expired'),/event_not_found/);
  }finally{f.store.close();}
});
test('ingress ledger failure rolls back receipt and inbox; retry accepts exactly once',()=>{
  const f=fixture();try{
    f.bind();f.store.db.exec("CREATE TRIGGER MOCK_ingress_failure BEFORE INSERT ON event_handling BEGIN SELECT RAISE(ABORT,'MOCK_INGRESS_FAILURE'); END");
    const receipts=f.store.db.prepare('SELECT count(*) AS n FROM receipts').get()!.n;
    assert.throws(()=>incoming(f),/MOCK_INGRESS_FAILURE/);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM inbox').get()!.n,0);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM receipts').get()!.n,receipts);
    f.store.db.exec('DROP TRIGGER MOCK_ingress_failure');const id=incoming(f);incoming(f);
    assert.equal(status(f,id).revision,0);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM event_handling').get()!.n,1);
  }finally{f.store.close();}
});
test('claim lease is capped by grant; invalid controls and stale completion cannot authorize sending',()=>{
  const f=fixture();try{
    f.bind();const id=incoming(f);f.alice.expiresAt=f.now()+2000;
    assert.throws(()=>f.bridge.handling.claim(f.alice,{event_id:id,request_id:'MOCK',revision:0,lease_ms:300001}),/300000/);
    assert.throws(()=>f.bridge.handling.claim(f.alice,{event_id:id,request_id:'MOCK',revision:0,owner:'MOCK_OTHER'}));
    const c=claim(f,id,'MOCK_grant',300000);assert.equal(c.lease_until,new Date(f.alice.expiresAt).toISOString());
    f.advance(2001);assert.throws(()=>f.bridge.handling.complete(f.alice,{event_id:id,revision:c.revision,outcome:'no_reply',reason:'sending_prohibited'}),/unauthorized/);
    f.alice.expiresAt=f.now()+3600000;assert.throws(()=>f.bridge.handling.complete(f.alice,{event_id:id,revision:c.revision,outcome:'no_reply',reason:'sending_prohibited'}),/handling_lease_expired/);
    assert.equal(f.sent.length,0);
  }finally{f.store.close();}
});
test('new MCP handling tools work on existing protected endpoint and never send on completion',async()=>{
  const f=fixture();try{
    f.bind();const id=incoming(f);const app=makeApp({authMode:'oauth',publicUrl:'http://127.0.0.1',issuer:'https://MOCK.invalid',apps:[mockApp],allowedOrigins:[]},f.bridge,{async authenticate(){return f.alice;}});
    async function call(name:string,args:unknown){const r=await app(new Request('http://127.0.0.1/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json,text/event-stream','MCP-Protocol-Version':'2026-07-28','Mcp-Method':'tools/call','Mcp-Name':name,authorization:'Bearer MOCK'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args,_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'MOCK',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}}})}));return (await r.json()).result;}
    const first=await call('get_event_handling',{event_id:id});assert.equal(JSON.parse(first.content[0].text).reply_state,'not_queued');
    const c=JSON.parse((await call('claim_event_processing',{event_id:id,request_id:'MOCK_mcp',revision:0})).content[0].text);
    assert.equal((await call('complete_event_handling',{event_id:id,revision:c.revision,outcome:'waiting_authorization'})).isError,undefined);
    assert.equal(JSON.parse((await call('list_event_alerts',{})).content[0].text).alerts[0].alert,'authorization_required');
    assert.equal((await call('reply_to_feishu',{event_id:id,text:'MOCK'})).isError,true);assert.equal(f.sent.length,0);
  }finally{f.store.close();}
});
test('schema 4 offline purge retains unresolved handling and retained coverage anchors', {skip:process.platform!=='linux'},()=>{
  const dir=mkdtempSync(join(tmpdir(),'MOCK-handling-purge-')),path=join(dir,'db.sqlite'),f=fixture(path);
  try{
    f.bind();const a=incoming(f,'anchor'),b=incoming(f,'covered'),unresolved=incoming(f,'unresolved');
    const q=f.bridge.reply(f.alice,{event_id:a,text:'MOCK'});f.store.db.prepare("UPDATE jobs SET state='sent' WHERE id=?").run(q.reply_id);
    const c=claim(f,b);f.bridge.handling.complete(f.alice,{event_id:b,revision:c.revision,outcome:'covered_by_reply',covering_event_id:a});
    f.store.db.prepare('UPDATE inbox SET timestamp=? WHERE id IN (?,?)').run(new Date(f.now()-40*86400000).toISOString(),a,unresolved);f.store.close();
    assert.equal(runMaintenance(['purge'],path,f.now()).counts!.inbox,0);
    const s=new Store(path);try{s.db.prepare('UPDATE inbox SET timestamp=? WHERE id=?').run(new Date(f.now()-40*86400000).toISOString(),b);}finally{s.close();}
    assert.equal(runMaintenance(['purge'],path,f.now()).counts!.inbox,2);
    const kept=new Store(path);try{assert.ok(kept.inbox(unresolved));assert.equal(kept.inbox(a),undefined);assert.equal(kept.inbox(b),undefined);}finally{kept.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});
