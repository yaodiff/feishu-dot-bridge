import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeApp, nodeServer } from '../src/http.js';
import { mockApp, encryptedCallback, feishuPayload } from './fixtures.js';
import { MOCK_TOKEN_A, MOCK_TOKEN_B, MOCK_INSTALL_A, personalFixture } from './personal-fixtures.js';
const meta={ 'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'MOCK-personal-client',version:'1'},'io.modelcontextprotocol/clientCapabilities':{} };
function requestParts(method: string, params: Record<string,unknown> = {}, headers: Record<string,string> = {}) {
  return { method:'POST', headers:{'content-type':'application/json',accept:'application/json, text/event-stream','MCP-Protocol-Version':'2026-07-28','Mcp-Method':method,...(method==='tools/call'?{'Mcp-Name':String(params.name)}:{}),...headers}, body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:{...params,_meta:meta}}) };
}
test('personal local TCP roundtrip authenticates backend, rejects header forgery and routes one owner', async () => {
  const f=personalFixture(), allowed:string[]=[];
  const app=makeApp({authMode:'personal-tunnel',publicUrl:'http://127.0.0.1',apps:[mockApp],allowedOrigins:[]},f.bridge,f.auth);
  const server=nodeServer(app,'http://127.0.0.1',allowed);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as {port:number}).port, origin=`http://127.0.0.1:${port}`;allowed.push(`127.0.0.1:${port}`);
  const rpc=async(method:string,params:Record<string,unknown>={},headers:Record<string,string>={'X-Bridge-Token':MOCK_TOKEN_A})=>fetch(origin+'/mcp',requestParts(method,params,headers));
  try {
    for(const headers of [{},{'Authorization':'Bearer '+MOCK_TOKEN_A},{'X-Bridge-Token':MOCK_TOKEN_B},{'X-Bridge-Token':MOCK_TOKEN_A+', '+MOCK_TOKEN_A},{'X-Forwarded-User':'owner'},{'X-Bridge-Token':'',Authorization:'Bearer '+MOCK_TOKEN_A}] as Record<string,string>[]) {const r=await rpc('server/discover',{},headers);assert.equal(r.status,401);assert.equal(r.headers.has('www-authenticate'),false);}
    assert.equal((await fetch(origin+'/.well-known/oauth-protected-resource/mcp')).status,404);
    const catalog=await(await rpc('tools/list')).json();assert.deepEqual(catalog.result.tools[0].securitySchemes,[{type:'noauth'}]);
    const spoof=await(await rpc('tools/call',{name:'begin_binding',arguments:{owner_id:'attacker'}})).json();assert.equal(spoof.result.isError,true);
    const pair=await(await rpc('tools/call',{name:'begin_binding',arguments:{}})).json();const command=JSON.parse(pair.result.content[0].text).command;
    const bind=encryptedCallback(feishuPayload(command,{messageId:'personal_pair'}));assert.equal((await fetch(origin+'/feishu/events/cli_mock',{method:'POST',headers:bind.headers,body:bind.raw})).status,200);
    const binding=f.store.binding(f.owner.id)!;
    const subscription=await(await rpc('events/subscribe',{name:'feishu.message.created',arguments:{binding_id:binding.id},delivery:{mode:'webhook',url:'https://callback.example/MOCK-personal',secret:f.secret},cursor:null})).json();assert.ok(subscription.result.id);
    const msg=encryptedCallback(feishuPayload('MOCK personal socket message',{messageId:'personal_message'}));for(let i=0;i<2;i++)await fetch(origin+'/feishu/events/cli_mock',{method:'POST',headers:msg.headers,body:msg.raw});
    await f.bridge.pump();assert.equal(f.calls.filter(c=>c.body.eventId).length,1);const eventId=f.calls.find(c=>c.body.eventId)!.body.eventId;
    await rpc('tools/call',{name:'reply_to_feishu',arguments:{event_id:eventId,text:'MOCK reply'}});await f.bridge.pump();assert.equal(f.sent[0]!.messageId,'personal_message');
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));f.store.close();}
});
test('separate personal installations reject each other’s credentials and do not share binding data', async () => {
  const a=personalFixture(), b=personalFixture('MOCK_installation_B',MOCK_TOKEN_B);
  try {
    const appB=makeApp({authMode:'personal-tunnel',publicUrl:'http://127.0.0.1:3000',apps:[mockApp],allowedOrigins:[]},b.bridge,b.auth);
    assert.equal((await appB(new Request('http://127.0.0.1:3000/mcp',requestParts('server/discover',{}, {'X-Bridge-Token':MOCK_TOKEN_A})))).status,401);
    const pair=a.bridge.beginBinding(a.owner);a.bridge.receive(a.message({text:pair.command}));assert.ok(a.store.binding(a.owner.id));assert.equal(b.store.binding(b.owner.id),undefined);
    assert.throws(()=>b.bridge.beginBinding(a.owner),/unauthorized/);
  } finally {a.store.close();b.store.close();}
});
test('actual main process boots loopback-only personal service with synthetic test config and shuts down', async () => {
  const dir=mkdtempSync(join(tmpdir(),'MOCK-personal-main-'));
  const portProbe=createServer();await new Promise<void>(resolve=>portProbe.listen(0,'127.0.0.1',resolve));const port=(portProbe.address() as {port:number}).port;await new Promise<void>(resolve=>portProbe.close(()=>resolve()));
  writeFileSync(join(dir,'token'),MOCK_TOKEN_A,{mode:0o600});writeFileSync(join(dir,'storage'),Buffer.alloc(32,31).toString('base64'),{mode:0o600});
  writeFileSync(join(dir,'app.json'),JSON.stringify({appId:'cli_MOCK_LOCAL_ONLY',tenantKey:'MOCK_TENANT',appSecretEnv:'MOCK_APP_SECRET',encryptKeyEnv:'MOCK_ENCRYPT_KEY',verificationTokenEnv:'MOCK_VERIFY_TOKEN',ingress:'webhook'}),{mode:0o600});
  // No real keys, no WS connection, no public callback, no outgoing provider calls.
  const child=spawn(process.execPath,[resolve('dist/src/main.js')],{cwd:dir,env:{PATH:process.env.PATH,AUTH_MODE:'personal-tunnel',INSTALLATION_ID:MOCK_INSTALL_A,HOST:'127.0.0.1',PORT:String(port),BRIDGE_TOKEN_FILE:join(dir,'token'),STORAGE_KEY_FILE:join(dir,'storage'),FEISHU_APP_FILE:join(dir,'app.json'),DATABASE_PATH:join(dir,'personal.sqlite'),CALLBACK_HOSTS:'callback.invalid',MOCK_APP_SECRET:'SYNTHETIC_ONLY',MOCK_ENCRYPT_KEY:'SYNTHETIC_ONLY',MOCK_VERIFY_TOKEN:'SYNTHETIC_ONLY'},stdio:['ignore','pipe','pipe']});
  try {
    let output='';const ready=new Promise<void>((resolve,reject)=>{child.stdout.on('data',data=>{output+=data.toString();if(output.includes('"event":"bridge_started"'))resolve();});child.once('exit',()=>reject(new Error('Synthetic service exited before ready')));});
    const deadline=setTimeout(()=>child.kill('SIGKILL'),5000);try{await ready;}finally{clearTimeout(deadline);}
    assert.match(output,/"mode":"personal-tunnel"/);
    const origin=`http://127.0.0.1:${port}`;assert.equal((await fetch(origin+'/healthz')).status,200);
    assert.equal((await fetch(origin+'/mcp',requestParts('server/discover'))).status,401);
    const catalog=await(await fetch(origin+'/mcp',requestParts('tools/list',{}, {'X-Bridge-Token':MOCK_TOKEN_A}))).json();assert.equal(catalog.result.tools.length,9);
    child.kill('SIGTERM');const [code]=await once(child,'exit');assert.equal(code,0);
  } finally {if(child.exitCode===null){child.kill('SIGKILL');await once(child,'exit');}rmSync(dir,{recursive:true,force:true});}
});
