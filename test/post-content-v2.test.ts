/** Derived from verified field structure only; all text/IDs/pixels are synthetic. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFeishuPost } from '../src/feishu-post.js';
import { decodeFeishu } from '../src/feishu.js';
import { MediaInputCandidate } from '../src/media-input.js';
import { fixture, feishuPayload, encryptedCallback, mockApp } from './fixtures.js';
const body=()=>[[{tag:'img',image_key:'img_SYNTHETIC_V2',width:12,height:8}],[{tag:'text',text:'ordinary synthetic post'}]];
const parse=(extra:unknown)=>parseFeishuPost(JSON.stringify({title:'',content:body(),content_v2:extra}),true);
test('exact section content_v2 row alias renders once and retains one image reference',()=>{
  const result=parse(body());assert.equal(result.text,'[图片 1]\nordinary synthetic post');assert.equal(result.postImages?.length,1);assert.equal(result.postImages?.[0]?.resourceKey,'img_SYNTHETIC_V2');
});
test('structural equality ignores object-key order but not array order',()=>{
  const reordered=[[{height:8,image_key:'img_SYNTHETIC_V2',tag:'img',width:12}],[{text:'ordinary synthetic post',tag:'text'}]];
  assert.equal(parse(reordered).text,'[图片 1]\nordinary synthetic post');
  const changed=parse([...body()].reverse());assert.ok(changed.text.includes('[富文本附加内容'));assert.equal(changed.text.split('ordinary synthetic post').length-1,2);
});
test('differing alias text and malformed values remain explicit and visible',()=>{
  const differing=body();differing[1]=[{tag:'text',text:'additional unique information'}];
  const changed=parse(differing);assert.ok(changed.text.includes('[富文本附加内容'));assert.ok(changed.text.includes('additional unique information'));
  const malformed=parse({text:'malformed but important text'});assert.ok(malformed.text.includes('[富文本附加内容'));assert.ok(malformed.text.includes('malformed but important text'));
  for(const value of [null,42,false,'scalar extra'])assert.ok(parse(value).text.includes('[富文本附加内容'));
});
test('different image identifiers or node metadata are never considered exact aliases',()=>{
  for(const rows of [ [[{tag:'img',image_key:'img_DIFFERENT',width:12,height:8}],[{tag:'text',text:'ordinary synthetic post'}]], [[{tag:'img',image_key:'img_SYNTHETIC_V2',width:13,height:8}],[{tag:'text',text:'ordinary synthetic post'}]] ]) {
    const result=parse(rows);assert.ok(result.text.includes('[富文本附加内容'));assert.equal(result.postImages?.length,1);assert.ok(!result.text.includes('img_DIFFERENT'));
  }
});
test('unknown duplicate fields and top-level wrapper extras are not silently deduplicated',()=>{
  const root=parseFeishuPost(JSON.stringify({title:'',content:body(),unrecognized_copy:body()}),true);assert.ok(root.text.includes('[富文本附加内容'));assert.equal(root.text.split('ordinary synthetic post').length-1,2);
  const wrapped=parseFeishuPost(JSON.stringify({zh_cn:{title:'',content:body()},content_v2:body()}),true);assert.ok(wrapped.text.includes('[富文本附加内容'));
});
test('within each locale, only its own exact content_v2 alias is suppressed',()=>{
  const section={title:'title',content:body(),content_v2:body()};const parsed=parseFeishuPost(JSON.stringify({zh_cn:section,en_us:section}),true);
  assert.equal(parsed.text.includes('[富文本附加内容'),false);assert.equal(parsed.text.split('ordinary synthetic post').length-1,2);assert.equal(parsed.postImages?.length,2);
});
test('credential and pairing material in alias is still scanned before equality suppression or fallback',()=>{
  for(const secret of ['password=MOCK_ONLY_V2','/bind aB2cD3eF4gH5iJ6kL7mN8oP9qR0sT1uV']) {
    const alias=[[{tag:'text',text:secret}]];const parsed=parse(alias);assert.equal(parsed.contentStatus,'credential_blocked');assert.equal(parsed.postImages,undefined);assert.ok(!parsed.text.includes(secret));
    const identical=parseFeishuPost(JSON.stringify({title:'',content:alias,content_v2:alias}),true);assert.equal(identical.contentStatus,'credential_blocked');
  }
});
test('different scalar types and prototype-named keys cannot trick equality',()=>{
  const rows=body();const bad=JSON.parse(JSON.stringify(rows));bad[0][0].width='12';assert.ok(parse(bad).text.includes('[富文本附加内容'));
  const extra=JSON.parse(JSON.stringify(rows));Object.defineProperty(extra[1][0],'__proto__',{value:{text:'distinct data'},enumerable:true});assert.ok(parse(extra).text.includes('[富文本附加内容'));
});
test('signed ingress persists and emits a single rendered copy without fetching media',async()=>{
  const f=fixture();f.bind();await f.subscribe();let downloads=0;const media=new MediaInputCandidate(f.bridge,{async download(){downloads++;throw new Error('NO_FETCH');}},()=>true,f.now);
  try{
    const payload=feishuPayload('',{type:'post',messageId:'om_SYNTHETIC_V2'});payload.event.message.create_time=String(f.now());payload.event.message.content=JSON.stringify({title:'',content:body(),content_v2:body()});
    const signed=encryptedCallback(payload,mockApp,f.now());const decoded=decodeFeishu(mockApp,signed.raw,new Headers(signed.headers),f.now(),true);assert.ok('message' in decoded);if(!('message' in decoded))throw new Error();media.receiveAuthenticated(decoded.message);
    const event=f.bridge.listPendingEvents(f.alice).events[0]!;assert.equal(event.text,'[图片 1]\nordinary synthetic post');assert.equal(media.describe(f.alice,event.event_id)?.image_count,1);await f.bridge.pump();
    const callback=f.calls.find(x=>x.body.data?.event_id);assert.equal(callback?.body.data.text,event.text);assert.equal(downloads,0);
    for(const table of ['inbox','jobs'])assert.ok(!JSON.stringify(f.store.db.prepare(`SELECT * FROM ${table}`).all()).includes('img_SYNTHETIC_V2'));
  }finally{media.close();f.store.close();}
});
