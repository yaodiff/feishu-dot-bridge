
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createCallbackTransport} from '../src/callback-runtime.js';
import {PublicHttpsCallback} from '../src/callback.js';
import {OpenAiManagedProxyCallback} from '../src/callback-proxy-candidate.js';
const host='connectors.api.openai.com';
const proxyEnv={CODEX_NETWORK_PROXY_ACTIVE:'1',HTTPS_PROXY:'http://127.0.0.1:12345'};
test('cloud transport requires explicit mode and the single approved callback host',()=>{
 assert.ok(createCallbackTransport({...proxyEnv,CALLBACK_HOSTS:host}) instanceof PublicHttpsCallback);
 assert.ok(createCallbackTransport({...proxyEnv,CALLBACK_HOSTS:host,CALLBACK_TRANSPORT:'managed-proxy-openai'}) instanceof OpenAiManagedProxyCallback);
 for(const hosts of ['', 'evil.example',host+',evil.example','*',host+','+host])assert.throws(()=>createCallbackTransport({...proxyEnv,CALLBACK_HOSTS:hosts,CALLBACK_TRANSPORT:'managed-proxy-openai'}),/requires_exact/);
 assert.throws(()=>createCallbackTransport({CALLBACK_HOSTS:host,CALLBACK_TRANSPORT:'managed-proxy-openai'}),/managed_proxy_required/);
});
for (const images of [false, true]) for (const feishuTransport of ['default', 'managed-proxy']) test('actual main boots approved explicit cloud callback and '+feishuTransport+' SDK transport; images='+images+' with synthetic secrets only',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'MOCK-cloud-main-'));const token=Buffer.alloc(32,17).toString('base64url');
 const probe=createServer();await new Promise<void>(r=>probe.listen(0,'127.0.0.1',r));const port=(probe.address() as {port:number}).port;await new Promise<void>(r=>probe.close(()=>r()));
 writeFileSync(join(dir,'token'),token,{mode:0o600});writeFileSync(join(dir,'storage'),Buffer.alloc(32,31).toString('base64'),{mode:0o600});
 writeFileSync(join(dir,'app.json'),JSON.stringify({appId:'cli_MOCK_CLOUD_ONLY',tenantKey:'MOCK_CLOUD_TENANT',appSecretEnv:'MOCK_APP_SECRET',encryptKeyEnv:'MOCK_ENCRYPT_KEY',verificationTokenEnv:'MOCK_VERIFY_TOKEN',ingress:'webhook'}),{mode:0o600});
 const child=spawn(process.execPath,[resolve('dist/src/main.js')],{cwd:dir,env:{PATH:process.env.PATH,...proxyEnv,FEISHU_TRANSPORT:feishuTransport,FEISHU_MEDIA_INPUT:images?'images-v1':'disabled',AUTH_MODE:'personal-tunnel',INSTALLATION_ID:'MOCK_cloud_runtime_approved',HOST:'127.0.0.1',PORT:String(port),BRIDGE_TOKEN_FILE:join(dir,'token'),STORAGE_KEY_FILE:join(dir,'storage'),FEISHU_APP_FILE:join(dir,'app.json'),DATABASE_PATH:join(dir,'personal.sqlite'),CALLBACK_HOSTS:host,CALLBACK_TRANSPORT:'managed-proxy-openai',MOCK_APP_SECRET:'SYNTHETIC_ONLY',MOCK_ENCRYPT_KEY:'SYNTHETIC_ONLY',MOCK_VERIFY_TOKEN:'SYNTHETIC_ONLY'},stdio:['ignore','pipe','pipe']});
 try{
  let output='';const ready=new Promise<void>((r,j)=>{child.stdout.on('data',b=>{output+=b.toString();if(output.includes('"bridge_started"'))r()});child.once('exit',()=>j(new Error('Cloud synthetic service exited before ready')))});
  const timer=setTimeout(()=>child.kill('SIGKILL'),5000);try{await ready}finally{clearTimeout(timer)}
  assert.equal((await fetch('http://127.0.0.1:'+port+'/healthz')).status,200);
  assert.match(output,/"mode":"personal-tunnel"/);
  const protocolMeta={'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'SYNTHETIC-MAIN',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}};
  const result=await (await fetch('http://127.0.0.1:'+port+'/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json,text/event-stream','MCP-Protocol-Version':'2026-07-28','Mcp-Method':'tools/list','X-Bridge-Token':token},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{_meta:protocolMeta}})})).json();
  assert.equal(result.result.tools.length,images?17:16);assert.equal(result.result.tools.some((t:{name:string})=>t.name==='get_event_image'),images);
  child.kill('SIGTERM');const [code]=await once(child,'exit');assert.equal(code,0);
 }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit')}rmSync(dir,{recursive:true,force:true})}
});
