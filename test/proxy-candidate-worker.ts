
/** TEST ONLY: fixed synthetic signing secret; no production account or public calls. */
import { OpenAiManagedProxyCallback, type CallbackPostDiagnostic } from '../src/callback-proxy-candidate.js';
import { Webhook } from 'standardwebhooks';
const secret='whsec_'+Buffer.alloc(32,29).toString('base64');
const target=process.argv[2]??'/success';
const body=JSON.stringify({type:'verification',challenge:'MOCK_CHALLENGE'});
const id='verify_MOCK',now=new Date();
const diagnostics: CallbackPostDiagnostic[]=[];
const includeDiagnostics=process.argv.includes('--diagnostics');
let candidate: OpenAiManagedProxyCallback | undefined;
try{
 candidate=new OpenAiManagedProxyCallback(process.env,includeDiagnostics?event=>{diagnostics.push(event);if(process.argv.includes('--reject-diagnostics'))return Promise.reject(new Error('MOCK_HOOK_PRIVATE_ERROR'));}:undefined);
 const result=target==='PROBE'?await candidate.probe():await candidate.post('https://connectors.api.openai.com'+target,body,{'content-type':'application/json','webhook-id':id,'webhook-timestamp':String(Math.floor(now.getTime()/1000)),'webhook-signature':new Webhook(secret).sign(id,now,body),'x-mcp-subscription-id':'sub_MOCK'});
 console.log(JSON.stringify({ok:true,status:result.status,bodyBytes:Buffer.byteLength(result.body),challenge:target==='/success'?JSON.parse(result.body).challenge:undefined,...(includeDiagnostics?{diagnostics}:{})}));
}catch(e){console.log(JSON.stringify({ok:false,error:e instanceof Error?e.message:'unknown',...(includeDiagnostics?{diagnostics}:{})}));}


finally { candidate?.close(); }
