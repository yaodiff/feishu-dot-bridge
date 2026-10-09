/** Synthetic rich posts, generated pixels and mocked message resources only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { parseFeishuPost, POST_LIMITS } from '../src/feishu-post.js';
import { decodeFeishu, decodeFeishuWebSocket } from '../src/feishu.js';
import { MediaInputCandidate } from '../src/media-input.js';
import { MEDIA_LIMITS } from '../src/media-policy.js';
import { makeApp } from '../src/http.js';
import { fixture, mockApp, feishuPayload, encryptedCallback } from './fixtures.js';
import type { Inbound } from '../src/types.js';
const post = (content: unknown[][], title = '') => JSON.stringify({ title, content });
const text = (value: string) => ({ tag:'text', text:value });
const img = (key: string) => ({tag:'img', image_key:key});
const decode = (raw: string, at: number, messageId = 'om_POST', enabled = true, mentions?: unknown): Inbound => {
  const payload = feishuPayload('', {type:'post',messageId}); payload.event.message.create_time=String(at);payload.event.message.content=raw;
  if(mentions !== undefined) Object.assign(payload.event.message,{mentions});
  const signed=encryptedCallback(payload, mockApp, at),result=decodeFeishu(mockApp,signed.raw,new Headers(signed.headers),at,enabled);assert.ok('message' in result);if(!('message' in result))throw new Error();return result.message;
};
const errorCode = (code: string) => (error: unknown) => error instanceof Error && error.message === code;

test('post preserves title, row order, empty rows, embedded newlines, links and mentions as plain untrusted text', () => {
  const raw=post([[text('first\nline'),{tag:'a',text:'docs',href:'https://example.invalid/a?b=1'},{tag:'at',user_id:'@_user_1'}],[],[text('last')]],'标题');
  const parsed=parseFeishuPost(raw,true,[{key:'@_user_1',name:'Alex'}]);
  assert.equal(parsed.text,'标题\nfirst\nlinedocs (https://example.invalid/a?b=1)@Alex\n\nlast');assert.equal(parsed.postImages,undefined);
});
test('locale compatibility keeps all supplied locale sections in source order rather than silently selecting one', () => {
  const parsed=parseFeishuPost(JSON.stringify({en_us:{title:'English',content:[[text('hello')]]},zh_cn:{title:'中文',content:[[text('你好')]]}}),false);
  assert.equal(parsed.text,'[语言：en_us]\nEnglish\nhello\n[语言：zh_cn]\n中文\n你好');
});
test('unknown nodes and extra fields retain text under explicit non-text omission markers', () => {
  const parsed=parseFeishuPost(post([[{tag:'future_tag',content:[{text:'important detail',image_key:'img_MUST_NOT_LEAK'}]},{tag:'text',text:'known',caption:'extra information'}, {tag:'file',file_key:'file_MUST_NOT_LEAK',file_name:'example.txt'}]]),true);
  for(const value of ['未支持','important detail','known','extra information','example.txt']) assert.ok(parsed.text.includes(value));
  assert.ok(!parsed.text.includes('img_MUST_NOT_LEAK'));assert.ok(!parsed.text.includes('file_MUST_NOT_LEAK'));assert.equal(parsed.postImages,undefined);
});
test('markdown/code/emotion/separators retain their literal data without interpretation', () => {
  const parsed=parseFeishuPost(post([[{tag:'md',text:'![do not fetch](https://example.invalid/x.png)'},{tag:'br'},{tag:'code_block',language:'js',content:'console.log("synthetic")'},{tag:'emotion',emoji_type:'SMILE'},{tag:'hr'}]]),true);
  assert.ok(parsed.text.includes('https://example.invalid/x.png'));assert.ok(parsed.text.includes('console.log'));assert.ok(parsed.text.includes('[表情：SMILE]'));assert.equal(parsed.postImages,undefined);
});
test('bounded images preserve order and expose only eligible validated refs, with explicit excess/invalid markers', () => {
  const parsed=parseFeishuPost(post([[text('a'),img('img_1'),text('b'),img('img_2'),img('img_3'),img('img_4'),img('img_5'),img('https://example.invalid/resource')]]),true);
  assert.equal(parsed.postImages?.length,4);assert.deepEqual(parsed.postImages?.map(x=>x.resourceKey),['img_1','img_2','img_3','img_4']);
  assert.ok(parsed.text.startsWith('a[图片 1]b[图片 2]'));assert.ok(parsed.text.includes('超过 4 张'));assert.ok(parsed.text.includes('引用无效'));assert.ok(!parsed.text.includes('https://'));
  assert.equal(Object.isFrozen(parsed.postImages),true);
});
test('post text still works with image processing disabled and explicitly labels unreadable image positions', () => {
  const parsed=parseFeishuPost(post([[text('keep text'),img('img_DISABLED')]]),false);
  assert.equal(parsed.text,'keep text[图片 1：图片读取未启用]');assert.equal(parsed.postImages,undefined);
});
for(const [name,raw,mentions] of [
  ['title',post([[img('img_SECRET')]],'password=MOCK_ONLY')],
  ['split label',post([[text('password'),text('='),text('MOCK_ONLY'),img('img_SECRET')]])],
  ['link',post([[{tag:'a',text:'link',href:'https://example.invalid/?access_token=MOCK_ONLY'},img('img_SECRET')]])],
  ['unknown node',post([[{tag:'future',value:'password=MOCK_ONLY'},img('img_SECRET')]])],
  ['other locale',JSON.stringify({zh_cn:{content:[[img('img_SECRET')]]},en_us:{content:[[text('password=MOCK_ONLY')]]}})],
  ['mention',post([[{tag:'at',user_id:'@_user_1'},img('img_SECRET')]]),[{key:'@_user_1',name:'password=MOCK_ONLY'}]]
] as const) test(`credential gate blocks whole post and all image refs: ${name}`,()=>{
  const parsed=parseFeishuPost(raw,true,mentions);assert.equal(parsed.contentStatus,'credential_blocked');assert.equal(parsed.postImages,undefined);assert.ok(!parsed.text.includes('MOCK_ONLY'));
});
test('malformed, empty and over-limit posts produce explicit notices without partial content or image refs', () => {
  for(const raw of ['{bad','[]','{}',JSON.stringify({content:'invalid'}),post(Array.from({length:POST_LIMITS.rows+1},()=>[])),post([[text('x'.repeat(POST_LIMITS.textChars+1)),img('img_OVER')]])]) {
    const parsed=parseFeishuPost(raw,true);assert.ok(parsed.text.startsWith('[未同步：'));assert.equal(parsed.postImages,undefined);
  }
  assert.equal(parseFeishuPost(post([]),true).text,'[空富文本消息]');
  const nested:Record<string,unknown>={};let current=nested;for(let i=0;i<15;i++){current.child={};current=current.child as Record<string,unknown>;}
  assert.ok(parseFeishuPost(post([[nested,img('img_DEEP')]]),true).text.includes('上限'));
});
test('signed HTTP and authenticated WS post normalization agree without storing raw structure', () => {
  const at=Date.now(),raw=post([[text('body'),img('img_POST')]],'title');const http=decode(raw,at);
  const wsApp={...mockApp,ingress:'websocket' as const},payload=feishuPayload('',{type:'post',messageId:'om_POST'});payload.event.message.content=raw;payload.event.message.create_time=String(at);
  const ws=decodeFeishuWebSocket(wsApp,{...payload.event,app_id:mockApp.appId,tenant_key:mockApp.tenantKey,event_type:'im.message.receive_v1'},at,true);
  assert.ok('message' in ws);if(!('message' in ws))throw new Error();assert.deepEqual(ws.message,http);assert.equal(http.text,'title\nbody[图片 1]');
  const disabled=decode(raw,at,'om_DISABLED',false);assert.equal(disabled.postImages,undefined);assert.ok(disabled.text.includes('读取未启用'));
});
test('two owned image indices reuse bounded resource transport and decoder; legacy event-only still reads first image', async()=>{
  const f=fixture();f.bind();await f.subscribe();const downloads:string[]=[];
  const pixels=await sharp({create:{width:5,height:7,channels:3,background:'#147ac3'}}).png().toBuffer();
  const media=new MediaInputCandidate(f.bridge,{async download(request,_signal,check){check();downloads.push(request.reference.resourceKey);assert.equal(request.messageId,'om_POST');return {bytes:Buffer.from(pixels),declaredMime:'image/png'};}},()=>true,f.now);
  try {
    media.receiveAuthenticated(decode(post([[text('before'),img('img_ONE'),text('between'),img('img_TWO'),text('after')]]),f.now()));
    const event=f.bridge.listPendingEvents(f.alice).events[0]!;assert.equal(event.text,'before[图片 1]between[图片 2]after');assert.equal(event.content_status,undefined);assert.equal(media.describe(f.alice,event.event_id)?.image_count,2);
    await f.bridge.pump();const callback=f.calls.find(x=>x.body.data?.media);assert.equal(callback?.body.data.media.image_count,2);
    for(const table of ['inbox','jobs'])assert.ok(!JSON.stringify(f.store.db.prepare(`SELECT * FROM ${table}`).all()).includes('img_ONE'));
    const one=await media.readImage(f.alice,{event_id:event.event_id});const two=await media.readImage(f.alice,{event_id:event.event_id,image_index:2});
    assert.deepEqual(downloads,['img_ONE','img_TWO']);assert.equal(JSON.parse((one.content[0] as {text:string}).text).image_index,1);assert.equal(JSON.parse((two.content[0] as {text:string}).text).image_index,2);
    assert.equal(one.content[1]?.type,'image');assert.equal(two.content[1]?.type,'image');
    for(const index of [0,1.5,5,'2'])await assert.rejects(media.readImage(f.alice,{event_id:event.event_id,image_index:index}));
    await assert.rejects(media.readImage(f.alice,{event_id:event.event_id,image_index:3}),errorCode('media_not_available'));
    await assert.rejects(media.readImage(f.bob,{event_id:event.event_id,image_index:2}),errorCode('event_not_found'));
    await assert.rejects(media.readImage(f.alice,{event_id:event.event_id,image_index:2,url:'https://example.invalid'}));assert.equal(downloads.length,2);
  } finally{media.close();f.store.close();}
});
test('whole-post credential rejection reaches callback as omission and never retains/fetches images', async()=>{
  const f=fixture();f.bind();await f.subscribe();let downloads=0;const media=new MediaInputCandidate(f.bridge,{async download(){downloads++;throw new Error('must not fetch');}},()=>true,f.now);
  try {
    media.receiveAuthenticated(decode(post([[text('password=MOCK_ONLY'),img('img_NOT_RETAINED')]]),f.now()));
    const event=f.bridge.listPendingEvents(f.alice).events[0]!;assert.equal(event.content_status,'credential_blocked');assert.equal(media.describe(f.alice,event.event_id),undefined);
    await assert.rejects(media.readImage(f.alice,{event_id:event.event_id}),errorCode('media_not_available'));
    // Defense in depth against an internal caller passing unsafe text and refs directly.
    media.receiveAuthenticated(f.message({messageId:'om_DIRECT_POST',text:'password=MOCK_ONLY',postImages:[{kind:'image',resourceType:'image',resourceKey:'img_DIRECT'}]}));
    const direct=f.bridge.listPendingEvents(f.alice).events[1]!;await assert.rejects(media.readImage(f.alice,{event_id:direct.event_id}),errorCode('media_not_available'));
    assert.equal(downloads,0);for(const table of ['inbox','jobs']){const saved=JSON.stringify(f.store.db.prepare(`SELECT * FROM ${table}`).all());assert.ok(!saved.includes('MOCK_ONLY'));assert.ok(!saved.includes('img_NOT_RETAINED'));}
  }finally{media.close();f.store.close();}
});
test('all image indices respect unlink, expiry, restart and activation fences', async()=>{
  const f=fixture();f.bind();await f.subscribe();let downloads=0;const transport={async download(){downloads++;throw new Error('must not fetch');}};
  const media=new MediaInputCandidate(f.bridge,transport,()=>true,f.now);
  try {
    media.receiveAuthenticated(decode(post([[img('img_ONE'),img('img_TWO')]]),f.now()));const event=f.bridge.listPendingEvents(f.alice).events[0]!;
    const restarted=new MediaInputCandidate(f.bridge,transport,()=>true,f.now);try{assert.equal(restarted.describe(f.alice,event.event_id)?.state,'media_unavailable_after_restart');assert.equal(restarted.describe(f.alice,event.event_id)?.image_count,2);await assert.rejects(restarted.readImage(f.alice,{event_id:event.event_id,image_index:2}),errorCode('media_not_available'));}finally{restarted.close();}
    f.advance(MEDIA_LIMITS.referenceTtlMs);assert.equal(media.describe(f.alice,event.event_id)?.state,'media_expired');await assert.rejects(media.readImage(f.alice,{event_id:event.event_id,image_index:2}),errorCode('media_not_available'));
    const before=decode(post([[img('img_OLD')]]),f.now()-1,'om_BEFORE');const fresh=new MediaInputCandidate(f.bridge,transport,()=>true,f.now);try{assert.equal(fresh.receiveAuthenticated(before).media_state,'media_before_activation');}finally{fresh.close();}
    f.bridge.unlink(f.alice);await assert.rejects(media.readImage(f.alice,{event_id:event.event_id,image_index:2}),errorCode('event_not_found'));assert.equal(downloads,0);
  }finally{media.close();f.store.close();}
});
test('reference capacity counts every embedded image, and duplicated events cannot replace first accepted refs',async()=>{
  const f=fixture();f.bind();const seen:string[]=[];const pixels=await sharp({create:{width:2,height:2,channels:3,background:'#eee'}}).png().toBuffer();
  const media=new MediaInputCandidate(f.bridge,{async download(request){seen.push(request.reference.resourceKey);return{bytes:Buffer.from(pixels),declaredMime:'image/png'};}},()=>true,f.now);
  try{
    for(let i=0;i<32;i++)assert.equal(media.receiveAuthenticated(decode(post([[img('img_A'),img('img_B'),img('img_C'),img('img_D')]]),f.now(),'om_POST_'+i)).media_state,'media_available');
    assert.equal(media.receiveAuthenticated(decode(post([[img('img_EXCESS')]]),f.now(),'om_EXCESS')).media_state,'media_capacity_exceeded');
    assert.equal(media.receiveAuthenticated(decode(post([[img('img_REPLACEMENT')]]),f.now(),'om_POST_0')).state,'duplicate');
    const event=f.bridge.listPendingEvents(f.alice).events[0]!;await media.readImage(f.alice,{event_id:event.event_id,image_index:2});assert.deepEqual(seen,['img_B']);
  }finally{media.close();f.store.close();}
});
test('MCP image index is optional and strict while tool count remains ten',async()=>{
  const f=fixture();f.bind();const media=new MediaInputCandidate(f.bridge,{async download(){throw new Error();}},()=>true,f.now);
  const app=makeApp({authMode:'oauth',publicUrl:'http://127.0.0.1',issuer:'https://example.invalid',apps:[mockApp],allowedOrigins:[]},f.bridge,{async authenticate(){return f.alice;}},media);
  const meta={'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'MOCK-rich-post',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}};
  const rpc=async(method:string,params:Record<string,unknown>={})=>(await(await app(new Request('http://127.0.0.1/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json,text/event-stream','MCP-Protocol-Version':'2026-07-28','Mcp-Method':method,...(method==='tools/call'?{'Mcp-Name':String(params.name)}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:{...params,_meta:meta}})}))).json()).result;
  try{
    const catalog=(await rpc('tools/list')).tools;assert.equal(catalog.length,10);const tool=catalog.find((x:{name:string})=>x.name==='get_event_image');assert.deepEqual(tool.inputSchema.required,['event_id']);assert.equal(tool.inputSchema.properties.image_index.default,1);assert.equal(tool.inputSchema.properties.image_index.maximum,4);assert.equal(tool.inputSchema.additionalProperties,false);
    const events=await rpc('events/list');assert.equal(events.events[0].payloadSchema.properties.media.properties.image_count.maximum,4);
  }finally{media.close();f.store.close();}
});
test('unknown resource metadata variants never become persisted text and code block secondary text is retained',()=>{
  const parsed=parseFeishuPost(post([[{tag:'future',text:'keep',resourceKey:'img_HIDDEN_A',imageKey:'img_HIDDEN_B',fileKey:'file_HIDDEN_C',nested:{arbitrary:'img_HIDDEN_D'}},{tag:'code_block',content:'primary',text:'secondary',language:'js'}]]),true);
  assert.ok(parsed.text.includes('keep'));assert.ok(parsed.text.includes('primary'));assert.ok(parsed.text.includes('secondary'));assert.ok(parsed.text.includes('代码语言：js'));
  for(const value of ['img_HIDDEN_A','img_HIDDEN_B','file_HIDDEN_C','img_HIDDEN_D'])assert.ok(!parsed.text.includes(value));
});
test('mention aliases from authenticated event metadata preserve names for open/user/union IDs',()=>{
  const parsed=parseFeishuPost(post([[{tag:'at',user_id:'ou_MOCK'},{tag:'at',user_id:'u_MOCK'},{tag:'at',user_id:'on_MOCK'}]]),true,[{key:'@_user_1',name:'Alex',id:{open_id:'ou_MOCK',user_id:'u_MOCK',union_id:'on_MOCK'}}]);
  assert.equal(parsed.text,'@Alex@Alex@Alex');
});
test('polling-only posts persist safe unavailable metadata across restart, expiry and rejected admission',async()=>{
  const f=fixture();f.bind();let downloads=0;const transport={async download(){downloads++;throw new Error('must not fetch');}};
  const media=new MediaInputCandidate(f.bridge,transport,()=>true,f.now),restarted=new MediaInputCandidate(f.bridge,transport,()=>true,f.now);
  try{
    media.receiveAuthenticated(decode(post([[text('keep'),img('img_POLL1'),img('img_POLL2')]]),f.now()));const event=f.bridge.listPendingEvents(f.alice).events[0]!;
    assert.equal(restarted.describe(f.alice,event.event_id)?.state,'media_unavailable_after_restart');assert.equal(restarted.describe(f.alice,event.event_id)?.image_count,2);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='media_notice'").get()!.n,1);
    const persisted=JSON.stringify(f.store.db.prepare('SELECT * FROM jobs').all());assert.ok(!persisted.includes('img_POLL1'));assert.ok(!persisted.includes('keep'));
    await f.bridge.pump();assert.equal(f.calls.length,0);assert.equal(f.sent.length,0);
    f.advance(MEDIA_LIMITS.referenceTtlMs);assert.equal(media.describe(f.alice,event.event_id)?.state,'media_expired');
    const late=new MediaInputCandidate(f.bridge,transport,()=>true,f.now);try{
      late.receiveAuthenticated(decode(post([[img('img_OLD')]]),f.now()-1,'om_OLD_POST'));const old=f.bridge.listPendingEvents(f.alice).events[1]!;
      assert.equal(restarted.describe(f.alice,old.event_id)?.state,'media_before_activation');
    }finally{late.close();}
    assert.equal(downloads,0);
  }finally{media.close();restarted.close();f.store.close();}
});
for(const mode of ['unlink','expiry'] as const)test(`selected second-image in-flight ${mode} returns no pixels`,async()=>{
  const f=fixture();f.bind();const pixels=await sharp({create:{width:3,height:4,channels:3,background:'#abc'}}).png().toBuffer();let release!:()=>void,started!:()=>void;const ready=new Promise<void>(r=>{started=r;});
  const media=new MediaInputCandidate(f.bridge,{async download(request){assert.equal(request.reference.resourceKey,'img_SECOND');started();await new Promise<void>(r=>{release=r;});return{bytes:Buffer.from(pixels),declaredMime:'image/png'};}},()=>true,f.now);
  try{
    media.receiveAuthenticated(decode(post([[img('img_FIRST'),img('img_SECOND')]]),f.now()));const event=f.bridge.listPendingEvents(f.alice).events[0]!;
    const read=media.readImage(f.alice,{event_id:event.event_id,image_index:2});await ready;if(mode==='unlink')f.bridge.unlink(f.alice);else f.advance(MEDIA_LIMITS.referenceTtlMs);release();
    await assert.rejects(read,errorCode(mode==='unlink'?'event_not_found':'media_not_available'));
  }finally{media.close();f.store.close();}
});
test('malformed known text fields preserve bounded textual fallback with an explicit format marker',()=>{
  const parsed=parseFeishuPost(post([[{tag:'a',href:'https://example.invalid',text:{text:'important link text'}},{tag:'code_block',content:{text:'important code'},text:'fallback'},{tag:'at',user_id:'ou_MOCK',user_name:{text:'important name'}},{tag:'emotion',text:{text:'important emotion'}}]]),true);
  for(const value of ['important link text','important code','important name','important emotion','格式异常'])assert.ok(parsed.text.includes(value));
});
test('post text resembling a pairing command remains untrusted content and cannot bind a new account',()=>{
  const f=fixture();try{const pair=f.bridge.beginBinding(f.alice);const received=f.bridge.receive(decode(post([[text(pair.command)]]),f.now()));assert.equal(received.state,'unbound');assert.equal(f.store.binding(f.alice.id),undefined);}finally{f.store.close();}
});
test('pairing code in already-bound rich post is omitted as a credential and never forwarded or retained with images',async()=>{
  const f=fixture();f.bind();await f.subscribe();let downloads=0;const media=new MediaInputCandidate(f.bridge,{async download(){downloads++;throw new Error();}},()=>true,f.now);
  try{
    const token='aB2cD3eF4gH5iJ6kL7mN8oP9qR0sT1uV';const message=decode(post([[text('/bind '),text(token),img('img_PAIRING')]]),f.now());
    assert.equal(message.contentStatus,'credential_blocked');assert.equal(message.postImages,undefined);media.receiveAuthenticated(message);
    const event=f.bridge.listPendingEvents(f.alice).events[0]!;assert.equal(event.content_status,'credential_blocked');await f.bridge.pump();assert.ok(!JSON.stringify(f.calls).includes(token));
    for(const table of ['inbox','jobs'])assert.ok(!JSON.stringify(f.store.db.prepare(`SELECT * FROM ${table}`).all()).includes(token));
    await assert.rejects(media.readImage(f.alice,{event_id:event.event_id}),errorCode('media_not_available'));assert.equal(downloads,0);
  }finally{media.close();f.store.close();}
});
