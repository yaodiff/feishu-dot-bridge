/** Official SDK over a mocked axios adapter. No DNS, tokens, user data or live sends. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import {Agent} from 'node:https';
import {LarkSender} from '../src/feishu.js';
import {mockApp} from './fixtures.js';
import {BridgeError} from '../src/types.js';
import {buildStatusCard} from '../src/status-card.js';
test('SDK uploads multipart message image, sends image/interactive and PATCHes accepted message ID',async()=>{
 const requests:{url:string;method:string;body:any;headers:any}[]=[];
 const http=axios.create({adapter:async config=>{
   requests.push({url:config.url!,method:config.method!,body:config.data,headers:config.headers});
   const data=config.url?.endsWith('/images') ? {code:0,data:{image_key:'img_SYNTHETIC_sdk'}} : {code:0,data:{message_id:'om_SYNTHETIC_sdk'}};
   return {data,status:200,statusText:'OK',headers:{},config};
 }});http.interceptors.response.use(r=>r.data);
 const sender=new LarkSender([mockApp],{http,wsAgent:new Agent(),startupTimeoutMs:1000,close(){}});
 // Prevent token requests entirely. Only synthetic token is available in this test.
 const client=(sender as any).clients.get(mockApp.appId);client.tokenManager.getTenantAccessToken=async()=>'MOCK_NOT_A_CREDENTIAL';
 const bytes=Buffer.from('SYNTHETIC_BYTE_TRANSPORT_ONLY');
 assert.equal(await sender.uploadImage(mockApp.appId,bytes),'img_SYNTHETIC_sdk');
 const form=requests[0]!.body;assert.ok(typeof form.getBuffer==='function');const multipart:Buffer=form.getBuffer();
 assert.ok(multipart.includes(bytes));assert.ok(multipart.includes(Buffer.from('name="image_type"')));assert.ok(multipart.includes(Buffer.from('message')));assert.match(requests[0]!.headers['Content-Type'],/multipart\/form-data/);
 assert.equal(await sender.sendImage(mockApp.appId,'oc_MOCK_bound','img_SYNTHETIC_sdk','MOCK_uuid'),'om_SYNTHETIC_sdk');
 const card=buildStatusCard({binding_id:'MOCK_binding',request_id:'MOCK_req',task_id:'MOCK_task',expected_revision:0,status:'waiting_confirmation',summary:'合成卡片',action:'检查候选',reason:'确认要求',existing_user_authorization:true});
 assert.equal(await sender.sendCard(mockApp.appId,'oc_MOCK_bound',card,'MOCK_uuid2'),'om_SYNTHETIC_sdk');await sender.patchCard(mockApp.appId,'om_SYNTHETIC_sdk',card);
 const image=JSON.parse(requests[1]!.body);assert.equal(image.msg_type,'image');assert.equal(image.receive_id,'oc_MOCK_bound');assert.deepEqual(JSON.parse(image.content),{image_key:'img_SYNTHETIC_sdk'});
 assert.equal(JSON.parse(requests[2]!.body).msg_type,'interactive');assert.equal(requests[3]!.method,'patch');assert.ok(requests[3]!.url.endsWith('/messages/om_SYNTHETIC_sdk'));assert.deepEqual(JSON.parse(JSON.parse(requests[3]!.body).content),card);
 assert.equal(requests.length,4);
});
test('nonzero provider code is definitive rejection; missing receipt remains ambiguous',async()=>{
 const http=axios.create({adapter:async config=>({data:{code:99999,msg:'SYNTHETIC do not retain raw'},status:200,statusText:'OK',headers:{},config})});http.interceptors.response.use(r=>r.data);
 const sender=new LarkSender([mockApp],{http,wsAgent:new Agent(),startupTimeoutMs:1000,close(){}});(sender as any).clients.get(mockApp.appId).tokenManager.getTenantAccessToken=async()=>'MOCK_TOKEN';
 await assert.rejects(sender.sendCard(mockApp.appId,'oc_MOCK',{},'MOCK_uuid'),e=>e instanceof BridgeError && e.code==='feishu_output_rejected');
 await assert.rejects(sender.uploadImage(mockApp.appId,Buffer.from('SYNTHETIC')),e=>e instanceof BridgeError && e.code==='feishu_output_rejected');
});
