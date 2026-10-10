/** Fresh synthetic databases and mock SDK replies only; no live account calls. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { fixture, mockApp } from './fixtures.js';
import { LarkSender } from '../src/feishu.js';
import { sanitizeReplyReceipt } from '../src/reply-receipt.js';
import { Store } from '../src/store.js';
import { Bridge } from '../src/bridge.js';
import { SecretBox, hash } from '../src/crypto.js';
import { makeApp } from '../src/http.js';
const columns = ['remoteMessageId','rootMessageId','parentMessageId','threadId','completedAt'];
const receipt = { messageId: 'om_MOCK_reply', rootId: 'om_MOCK_root', parentId: 'om_MOCK_parent', threadId: 'omt_MOCK_thread' };
function event(f: ReturnType<typeof fixture>, messageId = 'om_MOCK_original') {
  f.bridge.receive(f.message({ messageId }));
  return f.store.db.prepare('SELECT id FROM inbox WHERE messageId=?').get(messageId)!.id as string;
}
test('official reply request is unchanged and returns only bounded receipt fields', async () => {
  const sender = new LarkSender([mockApp]); let request: unknown; let data: unknown = {
    message_id: receipt.messageId, root_id: receipt.rootId, parent_id: receipt.parentId, thread_id: receipt.threadId,
    body: { content: 'MOCK_PRIVATE_BODY' }, token: 'MOCK_PRIVATE_TOKEN', sender: { id: 'MOCK_PERSONAL' }
  };
  (sender as unknown as { clients: Map<string, unknown> }).clients.set(mockApp.appId, { im: { message: {
    reply: async (args: unknown) => { request = args; return { code: 0, data }; }
  } } });
  assert.deepEqual(await sender.reply(mockApp.appId, 'om_MOCK_original', 'MOCK_TEXT', 'MOCK_UUID'), receipt);
  assert.deepEqual(request, { path: { message_id: 'om_MOCK_original' }, data: { content: JSON.stringify({ text: 'MOCK_TEXT' }), msg_type: 'text', uuid: 'MOCK_UUID' } });
  data = { message_id: 'MOCK_PRIVATE_TOKEN', parent_id: 'om_' + 'x'.repeat(254), root_id: 'om_bad\nheader', thread_id: 'https://MOCK_PRIVATE.invalid/?token=MOCK' };
  assert.deepEqual(await sender.reply(mockApp.appId, 'om_MOCK_original', 'MOCK_TEXT', 'MOCK_UUID'), {});
});
test('accepted receipt and completion persist together; status is safe and repeat reservation never resends', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'MOCK-reply-receipt-')), path = join(dir,'db.sqlite'), f = fixture(path);
  try {
    f.bind(); const id = event(f); let sends = 0;
    f.sender.reply = async () => { sends++; f.advance(25); return { ...receipt, body: 'MOCK_PRIVATE_BODY', token: 'MOCK_PRIVATE_TOKEN' }; };
    f.bridge.reply(f.alice, { event_id: id, text: 'MOCK_REPLY_BODY' }); await f.bridge.pump();
    const status = f.bridge.deliveryStatus(f.alice,id);
    assert.deepEqual(status, { event_id:id,state:'sent',attempts:1,message_id:receipt.messageId,root_id:receipt.rootId,parent_id:receipt.parentId,thread_id:receipt.threadId,completed_at:new Date(f.now()).toISOString() });
    assert.doesNotMatch(JSON.stringify(status), /MOCK_PRIVATE|MOCK_REPLY_BODY|oc_alice|ou_alice/);
    f.bridge.reply(f.alice,{event_id:id,text:'MOCK_REPLY_BODY'}); await f.bridge.pump(); assert.equal(sends,1);
    assert.throws(() => f.bridge.deliveryStatus(f.bob,id), /event_not_found/);
    f.store.close(); const reopened = new Store(path);
    try {
      const bridge = new Bridge(reopened,new SecretBox(f.storageKey),f.transport,f.sender,f.now);
      assert.deepEqual(bridge.deliveryStatus(f.alice,id),status);
      await bridge.pump(); assert.equal(sends,1);
    } finally { reopened.close(); }
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
test('missing or malformed optional receipt does not retry an accepted reply', async () => {
  const f = fixture(); try {
    f.bind(); const id = event(f); let sends=0;
    f.sender.reply = async () => { sends++; return { messageId: 'MOCK_PRIVATE_TOKEN', threadId: 'omt_'+'x'.repeat(253) }; };
    f.bridge.reply(f.alice,{event_id:id,text:'MOCK_REPLY'});await f.bridge.pump();await f.bridge.pump();
    assert.equal(sends,1);const status=f.bridge.deliveryStatus(f.alice,id);
    assert.deepEqual(status,{event_id:id,state:'sent',attempts:1,completed_at:new Date(f.now()).toISOString()});
    assert.deepEqual(sanitizeReplyReceipt(undefined),{});assert.deepEqual(sanitizeReplyReceipt(['MOCK_PRIVATE']),{});
  } finally {f.store.close();}
});
test('accepted API reply with failed receipt persistence becomes uncertain and never resends', async () => {
  const f=fixture();try{
    f.bind();const id=event(f);let sends=0;f.sender.reply=async()=>{sends++;return receipt;};
    f.bridge.reply(f.alice,{event_id:id,text:'MOCK_REPLY'});
    f.store.db.exec("CREATE TRIGGER MOCK_fail_receipt BEFORE UPDATE ON jobs WHEN NEW.state='sent' BEGIN SELECT RAISE(ABORT,'MOCK_STORAGE_FAILURE'); END");
    await f.bridge.pump();assert.equal(f.bridge.deliveryStatus(f.alice,id).state,'uncertain');assert.equal(sends,1);
    f.store.db.exec('DROP TRIGGER MOCK_fail_receipt');f.advance(1000);
    f.bridge.reply(f.alice,{event_id:id,text:'MOCK_REPLY'});await f.bridge.pump();
    assert.equal(sends,1);assert.equal(f.bridge.deliveryStatus(f.alice,id).attempts,1);
  }finally{f.store.close();}
});
for(const version of [1,2] as const)test('historical schema '+version+' upgrades without inventing receipts or replaying terminal replies',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'MOCK-receipt-upgrade-')),path=join(dir,'db.sqlite'),f=fixture(path);
  try{
    f.bind();const ids=[];
    for(const state of ['sent','uncertain']){
      const id=event(f,'om_MOCK_'+state);ids.push(id);
      const queued=f.bridge.reply(f.alice,{event_id:id,text:'MOCK_HISTORY'});
      f.store.db.prepare('UPDATE jobs SET state=?,attempts=1 WHERE id=?').run(state,queued.reply_id);
    }
    for(const name of columns)f.store.db.exec('ALTER TABLE jobs DROP COLUMN '+name);
    if(version===1)f.store.db.exec('DROP TABLE mirror_outbox;DROP TABLE content_dispositions');
    f.store.db.exec('PRAGMA user_version='+version);const before=f.store.db.prepare('SELECT id,state,attempts,payload FROM jobs ORDER BY seq').all();f.store.close();
    const upgraded=new Store(path);
    try{
      assert.equal(upgraded.db.prepare('PRAGMA user_version').get()!.user_version,3);
      assert.deepEqual(upgraded.db.prepare('SELECT id,state,attempts,payload FROM jobs ORDER BY seq').all(),before);
      for(const row of upgraded.db.prepare('SELECT remoteMessageId,rootMessageId,parentMessageId,threadId,completedAt FROM jobs').all())assert.ok(Object.values(row).every(v=>v===null));
      let sends=0;const bridge=new Bridge(upgraded,new SecretBox(f.storageKey),f.transport,{async reply(){sends++;return receipt;}},f.now);
      await bridge.pump();assert.equal(sends,0);
      for(const id of ids)assert.equal('completed_at' in bridge.deliveryStatus(f.alice,id),false);
    }finally{upgraded.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('delivery_status MCP exposes exact receipt fields without content or routing identity',async()=>{
  const f=fixture();try{
    f.bind();const id=event(f);f.sender.reply=async()=>receipt;f.bridge.reply(f.alice,{event_id:id,text:'MOCK_PRIVATE_REPLY'});await f.bridge.pump();
    const app=makeApp({authMode:'oauth',publicUrl:'http://127.0.0.1',issuer:'https://MOCK.invalid',apps:[mockApp],allowedOrigins:[]},f.bridge,{async authenticate(header){if(header!=='Bearer MOCK_OWNER')throw new Error('denied');return f.alice;}});
    const response=await app(new Request('http://127.0.0.1/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json,text/event-stream','MCP-Protocol-Version':'2026-07-28','Mcp-Method':'tools/call','Mcp-Name':'delivery_status',authorization:'Bearer MOCK_OWNER'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'delivery_status',arguments:{event_id:id},_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'MOCK',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}}})}));
    const result=await response.json();assert.equal(response.status,200);
    const status=JSON.parse(result.result.content[0].text);assert.equal(status.message_id,receipt.messageId);assert.equal(status.thread_id,receipt.threadId);assert.equal(status.state,'sent');
    assert.doesNotMatch(JSON.stringify(status),/MOCK_PRIVATE|oc_alice|ou_alice/);
  }finally{f.store.close();}
});

test('both accepted-reply receipt and uncertain writes fail: restart never calls reply again',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'MOCK-receipt-double-failure-')),path=join(dir,'db.sqlite'),f=fixture(path);
  try{
    f.bind();const id=event(f);let sends=0;
    f.sender.reply=async()=>{sends++;return receipt;};
    f.bridge.reply(f.alice,{event_id:id,text:'MOCK_REPLY'});
    f.store.db.exec("CREATE TRIGGER MOCK_both_writes_fail BEFORE UPDATE ON jobs WHEN NEW.kind='reply' AND NEW.state IN ('sent','uncertain') BEGIN SELECT RAISE(ABORT,'MOCK_BOTH_WRITES_FAILED'); END");
    await assert.rejects(f.bridge.pump(),/MOCK_BOTH_WRITES_FAILED/);
    assert.equal(sends,1);assert.equal(f.bridge.deliveryStatus(f.alice,id).state,'sending');
    f.store.close();
    // Recover only synthetic storage. Never alter a real runtime database.
    const repaired=new DatabaseSync(path);repaired.exec('DROP TRIGGER MOCK_both_writes_fail');repaired.close();
    const restarted=new Store(path);
    try{
      const bridge=new Bridge(restarted,new SecretBox(f.storageKey),f.transport,f.sender,f.now);
      assert.equal(bridge.deliveryStatus(f.alice,id).state,'uncertain');
      assert.equal(bridge.deliveryStatus(f.alice,id).attempts,1);
      bridge.reply(f.alice,{event_id:id,text:'MOCK_REPLY'});
      await bridge.pump();f.advance(3600000);await bridge.pump();
      assert.equal(sends,1);assert.equal(restarted.job('reply_' + hash(id))!.state,'uncertain');
    }finally{restarted.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});
for(const version of [2,3] as const)test('schema '+version+' startup treats attempted replies as uncertain but retains callback recovery',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'MOCK-receipt-startup-')),path=join(dir,'db.sqlite'),f=fixture(path);
  try{
    f.bind();await f.subscribe();const id=event(f);
    const queued=f.bridge.reply(f.alice,{event_id:id,text:'MOCK_REPLY'});
    f.store.db.prepare("UPDATE jobs SET state='sending',attempts=1,firstAttemptAt=?").run(f.now());
    if(version===2){for(const name of columns)f.store.db.exec('ALTER TABLE jobs DROP COLUMN '+name);f.store.db.exec('PRAGMA user_version=2');}
    f.store.close();const recovered=new Store(path);
    try{
      assert.equal(recovered.job(queued.reply_id)!.state,'uncertain');
      assert.equal(recovered.db.prepare("SELECT state FROM jobs WHERE kind='event'").get()!.state,'pending');
      let sends=0;const bridge=new Bridge(recovered,new SecretBox(f.storageKey),f.transport,{async reply(){sends++;return receipt;}},f.now);
      await bridge.pump();assert.equal(sends,0);
      assert.equal(recovered.db.prepare("SELECT state FROM jobs WHERE kind='event'").get()!.state,'sent');
      assert.equal(recovered.job(queued.reply_id)!.state,'uncertain');
    }finally{recovered.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});
