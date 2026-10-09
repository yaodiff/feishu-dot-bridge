
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer as httpsServer} from 'node:https';
import {createServer as httpServer} from 'node:http';
import {connect} from 'node:net';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {once} from 'node:events';
import {Webhook} from 'standardwebhooks';
import {validateOpenAiCallback,managedProxyFromEnvironment,OpenAiManagedProxyCallback,type CallbackPostDiagnostic} from '../src/callback-proxy-candidate.js';
import {createCallbackTransport} from '../src/callback-runtime.js';
import {PublicHttpsCallback} from '../src/callback.js';
import {BridgeError} from '../src/types.js';

const HOST='connectors.api.openai.com',URL='https://'+HOST;
const env={CODEX_NETWORK_PROXY_ACTIVE:'1',HTTPS_PROXY:'http://127.0.0.1:12345'};
const headers={'content-type':'application/json','webhook-id':'MOCK_ID','webhook-timestamp':'1234567890','webhook-signature':'v1,MOCK','x-mcp-subscription-id':'sub_MOCK'};
function assertSafeDiagnostics(diagnostics:CallbackPostDiagnostic[]){
 let previous=0;
 for(const item of diagnostics){
  assert.ok(Object.keys(item).every(key=>['stage','outcome','reason','elapsedMs','httpStatus','hostname'].includes(key)));
  assert.ok(['validation','proxy_connect','tls_handshake','request','response'].includes(item.stage));
  assert.ok(['started','succeeded','failed'].includes(item.outcome));
  assert.ok(['none','invalid_callback','invalid_callback_headers','callback_request_too_large','callback_timeout','callback_proxy_connect_failed','callback_tls_failed','callback_failed','callback_redirect_rejected','callback_response_too_large','callback_upgrade_rejected'].includes(item.reason));
  assert.ok(Number.isInteger(item.elapsedMs)&&item.elapsedMs>=previous);previous=item.elapsedMs;
  if(item.hostname!==undefined)assert.equal(item.hostname,HOST);
  if(item.httpStatus!==undefined)assert.ok(Number.isInteger(item.httpStatus)&&item.httpStatus>=100&&item.httpStatus<=599);
 }
 if(diagnostics.length){
  assert.ok(diagnostics.length<=11,'Each POST has a bounded number of lifecycle observations');
  assert.notEqual(diagnostics.at(-1)?.outcome,'started');
  assert.equal(diagnostics.filter(item=>item.outcome==='failed').length,diagnostics.at(-1)?.outcome==='failed'?1:0);
 }
 assert.doesNotMatch(JSON.stringify(diagnostics),/MOCK|whsec_|webhook|challenge|token|private|\?|https?:\/\//);
}
test('optional post diagnostics expose only fixed sanitized metadata and cannot change validation failures',async()=>{
 const diagnostics:CallbackPostDiagnostic[]=[];
 const candidate=new OpenAiManagedProxyCallback(env,item=>{assert.ok(Object.isFrozen(item));diagnostics.push(item)});
 await assert.rejects(candidate.post('https://MOCK_PRIVATE.invalid/MOCK_TOKEN?secret=MOCK_SECRET','MOCK_BODY',headers),/invalid_callback/);
 assert.deepEqual(diagnostics.map(({stage,outcome,reason,hostname})=>({stage,outcome,reason,hostname})),[
  {stage:'validation',outcome:'started',reason:'none',hostname:undefined},
  {stage:'validation',outcome:'failed',reason:'invalid_callback',hostname:undefined}
 ]);
 assertSafeDiagnostics(diagnostics);diagnostics.length=0;
 await assert.rejects(candidate.post(URL+'/MOCK_PRIVATE?token=MOCK_TOKEN','MOCK_BODY',{...headers,authorization:'MOCK_CREDENTIAL'}),/invalid_callback_headers/);
 assert.equal(diagnostics.at(-1)?.hostname,HOST);assert.equal(diagnostics.at(-1)?.reason,'invalid_callback_headers');assertSafeDiagnostics(diagnostics);diagnostics.length=0;
 const hostileHeaders=Object.defineProperty({},'MOCK_HEADER',{enumerable:true,get:()=>{throw new BridgeError('MOCK_UNSAFE_REASON_WITH_SECRET')}});
 await assert.rejects(candidate.post(URL+'/MOCK_PRIVATE','MOCK_BODY',hostileHeaders),/MOCK_UNSAFE_REASON_WITH_SECRET/);
 assert.equal(diagnostics.at(-1)?.reason,'callback_failed');assertSafeDiagnostics(diagnostics);
 const throwing=new OpenAiManagedProxyCallback(env,()=>{throw new Error('MOCK_OBSERVER_PRIVATE_ERROR')});
 await assert.rejects(throwing.post(URL+'/MOCK_PRIVATE','MOCK_BODY',{}),/invalid_callback_headers/);
});
test('runtime factory forwards the optional post hook only to the selected managed transport',async()=>{
 const diagnostics:CallbackPostDiagnostic[]=[];
 const candidate=createCallbackTransport({...env,CALLBACK_TRANSPORT:'managed-proxy-openai',CALLBACK_HOSTS:HOST},undefined,item=>diagnostics.push(item));
 await assert.rejects(candidate.post(URL+'/MOCK_PRIVATE','{}',{}),/invalid_callback_headers/);
 assert.equal(diagnostics.at(-1)?.reason,'invalid_callback_headers');assertSafeDiagnostics(diagnostics);
});
test('proxy candidate accepts only literal approved HTTPS authority and preserves callback query',()=>{
 assert.equal(validateOpenAiCallback(URL+':443/private?a=1%2F2').href,URL+'/private?a=1%2F2');
 for(const raw of ['http://'+HOST,URL+':444/x',URL+':0443/x','https://127.0.0.1/x','https://2130706433/x','https://[::1]/x','https://'+HOST+'.evil/x','https://'+HOST+'./x','https://u@'+HOST,'https://@'+HOST,URL+'/#',URL+'/#fragment',URL+'\\x',' '+URL,URL+'\n','https://%63onnectors.api.openai.com/x','https://CONNECTORS.API.OPENAI.COM/x',URL+'/'.repeat(4096)]){
  assert.throws(()=>validateOpenAiCallback(raw),/invalid_callback/,raw);
 }
});
test('proxy candidate rejects unrecognized, conflicting and remote proxy sources',()=>{
 assert.equal(managedProxyFromEnvironment(env),env.HTTPS_PROXY);
 assert.equal(managedProxyFromEnvironment({...env,NO_PROXY:'*'}),env.HTTPS_PROXY);
 for(const bad of [{...env,CODEX_NETWORK_PROXY_ACTIVE:'0'},{CODEX_NETWORK_PROXY_ACTIVE:'1'},{...env,https_proxy:'http://127.0.0.1:12346'},...[ 'http://remote.example:80','http://u:p@127.0.0.1:12345','http://127.0.0.1:12345/path','http://127.0.0.1:12345/?q=x','http://127.0.0.1:12345/#','socks5://127.0.0.1:12345','http://2130706433:12345','http://127.0.0.1:65536','http://127.0.0.1:0'].map(v=>({...env,HTTPS_PROXY:v}))]){
  assert.throws(()=>managedProxyFromEnvironment(bad));
 }
});
test('proxy candidate rejects request/header abuse before network',async()=>{
 const c=new OpenAiManagedProxyCallback(env);
 for(const bad of [{...headers,Host:'evil.test'},{...headers,Authorization:'x'},{...headers,Cookie:'x'},{...headers,'Proxy-Authorization':'x'},{...headers,'content-length':'1'},{...headers,'Content-Type':'application/json'},{...headers,'webhook-id':'x\r\nAuthorization:y'},{...headers,'webhook-signature':'x'.repeat(4097)},{...headers,'content-type':'text/plain'}]){
  await assert.rejects(c.post(URL+'/','{}',bad),/invalid_callback_headers/);
 }
 await assert.rejects(c.post(URL+'/','界'.repeat(87382),headers),/callback_request_too_large/);
 for(const value of ['\u0001','\u007f','😀']) await assert.rejects(c.post(URL+'/','{}',{...headers,'webhook-id':value}),/invalid_callback_headers/);
 await assert.rejects(c.post('https://localhost/','{}',headers),/invalid_callback/);
 assert.equal(c.assurance.applicationDnsPinning,false);
});
test('production defaults to direct pinned transport and candidate selection cannot activate',()=>{
 assert.ok(createCallbackTransport({CALLBACK_HOSTS:HOST}) instanceof PublicHttpsCallback);
 assert.throws(()=>createCallbackTransport({CALLBACK_TRANSPORT:'managed-proxy-openai-candidate'}),/disabled_security_review_required/);
 assert.throws(()=>createCallbackTransport({CALLBACK_TRANSPORT:'unknown'}),/invalid_callback_transport/);
 const child=spawn(process.execPath,[resolve('dist/src/main.js')],{env:{PATH:process.env.PATH,CALLBACK_TRANSPORT:'managed-proxy-openai-candidate'},stdio:['ignore','ignore','pipe']});
 return new Promise<void>((resolve,reject)=>{let output='';child.stderr.on('data',b=>output+=b.toString());child.once('error',reject);child.once('exit',code=>{try{assert.notEqual(code,0);assert.match(output,/callback_proxy_candidate_disabled_security_review_required/);assert.doesNotMatch(output,/Missing INSTALLATION_ID|Missing BRIDGE_TOKEN/);resolve()}catch(e){reject(e)}})});
});

test('actual local CONNECT proxy keeps TLS, signs challenge, blocks redirects/overflow/timeouts', {timeout:105000},async(t)=>{
 const dir=mkdtempSync(join(tmpdir(),'MOCK-proxy-tls-'));const key=join(dir,'key.pem'),cert=join(dir,'cert.pem'),wrongKey=join(dir,'wrong-key.pem'),wrongCert=join(dir,'wrong-cert.pem');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-subj','/CN='+HOST,'-addext','subjectAltName=DNS:'+HOST,'-days','1'],{stdio:'ignore'});chmodSync(key,0o600);
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',wrongKey,'-out',wrongCert,'-subj','/CN=wrong.invalid','-addext','subjectAltName=DNS:wrong.invalid','-days','1'],{stdio:'ignore'});chmodSync(wrongKey,0o600);
 const secret='whsec_'+Buffer.alloc(32,29).toString('base64');let requests=0,connects=0,signatureVerified=0,probeHeadersSafe=false,seenQuery=false;
 const timers:NodeJS.Timeout[]=[];const sockets=new Set<import('node:stream').Duplex>();
 const target=httpsServer({key:readFileSync(key),cert:readFileSync(cert)},async(req,res)=>{
  requests++;if(req.method==='HEAD'){probeHeadersSafe=!req.headers['webhook-signature']&&!req.headers.authorization&&!req.headers.cookie;res.writeHead(404);res.end();return}
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const body=Buffer.concat(chunks).toString();new Webhook(secret).verify(body,req.headers as Record<string,string>);signatureVerified++;
  if(req.url==='/redirect'){res.writeHead(302,{location:'https://127.0.0.1/private'});res.end()}
  else if(req.url==='/unauthorized'){res.writeHead(401);res.end('MOCK_PRIVATE_RESPONSE_BODY')}
  else if(req.url==='/oversized'){res.end('x'.repeat(65537))}
  else if(req.url==='/boundary'){res.end('x'.repeat(65536))}
  else if(req.url==='/abort'){res.writeHead(200,{'content-length':'999'});res.write('partial');res.destroy()}
  else if(req.url==='/hang'){/* Deadline owns cleanup. */}
  else if(req.url==='/upgrade'){res.writeHead(101,{connection:'Upgrade',upgrade:'websocket'});res.end()}
  else if(req.url?.startsWith('/query?')){seenQuery=req.url==='/query?a=1%2F2';res.end('{}')}
  else{res.end(JSON.stringify({challenge:JSON.parse(body).challenge}))}
 });
 target.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s))});
 await new Promise<void>(r=>target.listen(0,'127.0.0.1',r));const tlsPort=(target.address() as {port:number}).port;
 const proxy=httpServer();let rejectConnect=false;let connectMode:'normal'|'delayed'|'stall'|'trickle'|'tls-stall'|'tls-trickle'='normal';
 proxy.on('connect',(req,socket,head)=>{connects++;assert.equal(req.url,HOST+':443');assert.equal(req.headers['proxy-authorization'],undefined);sockets.add(socket);socket.on('error',()=>socket.destroy());socket.on('end',()=>socket.end());socket.on('close',()=>sockets.delete(socket));if(rejectConnect){socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');return}
  if(connectMode==='stall'){socket.resume();return;}
  if(connectMode==='trickle'){socket.resume();socket.write('HTTP/1.1 200 Connection Established\r\nX-Mock: ');const timer=setInterval(()=>{if(socket.destroyed)clearInterval(timer);else socket.write('x')},100);timers.push(timer);return}
  if(connectMode==='tls-stall'||connectMode==='tls-trickle'){
   socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');socket.on('data',()=>{});
   // Wait for ClientHello so TLS bytes cannot coalesce into the CONNECT response head.
   if(connectMode==='tls-trickle')socket.once('data',()=>{socket.write(Buffer.from([0x16,0x03,0x03,0x03,0xe8,0x02]));const timer=setInterval(()=>{if(socket.destroyed)clearInterval(timer);else socket.write(Buffer.from([0]))},100);timers.push(timer)});
   return;
  }
  const establish=()=>{if(socket.destroyed)return;
  const upstream=connect(tlsPort,'127.0.0.1',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream);upstream.pipe(socket)});
  sockets.add(upstream);sockets.add(socket);upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());upstream.on('close',()=>{sockets.delete(upstream);socket.destroy()});socket.on('close',()=>{sockets.delete(socket);upstream.destroy()});
  };
  if(connectMode==='delayed')timers.push(setTimeout(establish,11000));else establish();
 });
 await new Promise<void>(r=>proxy.listen(0,'127.0.0.1',r));const port=(proxy.address() as {port:number}).port;
 let lastDiagnostics:CallbackPostDiagnostic[]=[];
 async function worker(path:string,trust=true,ca=cert,rejectDiagnostics=false){const started=Date.now();const child=spawn(process.execPath,[resolve('dist/test/proxy-candidate-worker.js'),path,'--diagnostics',...(rejectDiagnostics?['--reject-diagnostics']:[])],{env:{PATH:process.env.PATH,CODEX_NETWORK_PROXY_ACTIVE:'1',HTTPS_PROXY:'http://127.0.0.1:'+port,NO_PROXY:'*',...(trust?{NODE_EXTRA_CA_CERTS:ca}:{})},stdio:['ignore','pipe','pipe']});let output='';let errors='';child.stdout.on('data',b=>output+=b.toString());child.stderr.on('data',b=>errors+=b.toString());const watchdog=setTimeout(()=>child.kill('SIGKILL'),18000);let code:unknown;try{[code]=await once(child,'exit')}finally{clearTimeout(watchdog)}assert.equal(code,0,'Worker must exit naturally without leftover handles: '+errors);await new Promise(r=>setTimeout(r,50));assert.equal(sockets.size,0,'Transport sockets must close before fixture teardown');if(connectMode!=='normal'||path==='/hang')t.diagnostic(connectMode+' '+path+': '+(Date.now()-started)+'ms, natural exit, 0 fixture sockets');const result=JSON.parse(output.trim());lastDiagnostics=result.diagnostics;assertSafeDiagnostics(lastDiagnostics);delete result.diagnostics;return result as {ok:boolean;error?:string;status?:number;bodyBytes?:number;challenge?:string}}
 try{
  const success=await worker('/success');assert.deepEqual(success,{ok:true,status:200,bodyBytes:30,challenge:'MOCK_CHALLENGE'});
  assert.deepEqual(lastDiagnostics.filter(d=>d.outcome==='succeeded').map(d=>d.stage),['validation','proxy_connect','tls_handshake','request','response']);
  assert.equal(lastDiagnostics.at(-1)?.httpStatus,200);assert.equal(lastDiagnostics.at(-1)?.reason,'none');
  assert.deepEqual(await worker('/success',true,cert,true),success,'Rejected diagnostic-hook promises must not affect delivery or process exit');
  connectMode='delayed';const delayedStart=Date.now();assert.deepEqual(await worker('/success'),success);const delayedElapsed=Date.now()-delayedStart;assert.ok(delayedElapsed>=10900&&delayedElapsed<15000,'CONNECT after 11s must succeed inside the fixed 15s total deadline');connectMode='normal';
  assert.ok(signatureVerified>0);assert.ok(connects>0,'NO_PROXY=* must not bypass pinned runtime proxy selection');
  await worker('/query?a=1%2F2');assert.ok(seenQuery);
  const before=requests;assert.equal((await worker('/redirect')).error,'callback_redirect_rejected');assert.equal(lastDiagnostics.at(-1)?.httpStatus,302);assert.equal(lastDiagnostics.at(-1)?.stage,'response');assert.equal(lastDiagnostics.at(-1)?.outcome,'failed');assert.equal(requests,before+1);
  assert.equal((await worker('/boundary')).bodyBytes,65536);
  assert.equal((await worker('/unauthorized')).status,401);assert.equal(lastDiagnostics.at(-1)?.httpStatus,401);assert.equal(lastDiagnostics.at(-1)?.outcome,'succeeded','A completed HTTP exchange is not a verified challenge');
  assert.equal((await worker('/oversized')).error,'callback_response_too_large');
  assert.equal((await worker('/abort')).error,'callback_failed');
  assert.equal((await worker('/upgrade')).error,'callback_upgrade_rejected');assert.equal(lastDiagnostics.at(-1)?.httpStatus,101);
  assert.equal((await worker('/success',false)).error,'callback_tls_failed');assert.equal(lastDiagnostics.at(-1)?.stage,'tls_handshake');assert.equal(lastDiagnostics.at(-1)?.httpStatus,undefined);
  target.setSecureContext({key:readFileSync(wrongKey),cert:readFileSync(wrongCert)});
  assert.equal((await worker('/success',true,wrongCert)).error,'callback_tls_failed');
  target.setSecureContext({key:readFileSync(key),cert:readFileSync(cert)});
  const probe=await worker('PROBE');assert.equal(probe.status,404);assert.ok(probeHeadersSafe);assert.equal(lastDiagnostics.length,0,'Public HEAD probe must not be reported as a callback POST');
  rejectConnect=true;assert.equal((await worker('/success')).error,'callback_proxy_connect_failed');assert.equal(lastDiagnostics.at(-1)?.stage,'proxy_connect');assert.equal(lastDiagnostics.at(-1)?.httpStatus,502);rejectConnect=false;
  for(const mode of ['stall','trickle'] as const){connectMode=mode;const before=Date.now();assert.equal((await worker('/success')).error,'callback_proxy_connect_failed');const elapsed=Date.now()-before;assert.ok(elapsed>=11900&&elapsed<14500,mode+' CONNECT must respect its absolute 12s deadline');assert.equal(lastDiagnostics.at(-1)?.stage,'proxy_connect');assert.equal(lastDiagnostics.at(-1)?.reason,'callback_proxy_connect_failed');connectMode='normal'}
  for(const mode of ['tls-stall','tls-trickle'] as const){connectMode=mode;const before=Date.now();assert.equal((await worker('/success')).error,'callback_timeout');const elapsed=Date.now()-before;assert.ok(elapsed>=14900&&elapsed<17500,mode+' must respect the absolute 15s deadline');assert.equal(lastDiagnostics.at(-1)?.stage,'tls_handshake');assert.equal(lastDiagnostics.at(-1)?.reason,'callback_timeout');connectMode='normal'}
  connectMode='delayed';const start=Date.now();assert.equal((await worker('/hang')).error,'callback_timeout');const elapsed=Date.now()-start;assert.ok(elapsed>=14900&&elapsed<17500);assert.equal(lastDiagnostics.at(-1)?.stage,'response');assert.equal(lastDiagnostics.at(-1)?.reason,'callback_timeout');
 }finally{for(const timer of timers)clearTimeout(timer);for(const s of sockets)s.destroy();await Promise.all([new Promise<void>(r=>proxy.close(()=>r())),new Promise<void>(r=>target.close(()=>r()))]);rmSync(dir,{recursive:true,force:true})}
});
