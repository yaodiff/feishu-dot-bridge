/** OFFLINE MOCK: two completely independent personal installations, not shared hosting. */
import { personalFixture, MOCK_TOKEN_A, MOCK_TOKEN_B } from '../test/personal-fixtures.js';
const installs=[personalFixture('MOCK_personal_host_A',MOCK_TOKEN_A),personalFixture('MOCK_personal_host_B',MOCK_TOKEN_B)];
try {
  for(const [index,f] of installs.entries()) {
    const pair=f.bridge.beginBinding(f.owner);f.bridge.receive(f.message({messageId:'pair',text:pair.command}));const binding=f.store.binding(f.owner.id)!;
    await f.bridge.subscribe(f.owner,{name:'feishu.message.created',arguments:{binding_id:binding.id},delivery:{mode:'webhook',url:`https://callback.example/MOCK-installation-${index}`,secret:f.secret},cursor:null});
    f.bridge.receive(f.message({text:`MOCK message on independent host ${index+1}`}));await f.bridge.pump();const eventId=f.calls.find(c=>c.body.eventId)!.body.eventId;
    f.bridge.reply(f.owner,{event_id:eventId,text:'MOCK personal dot reply'});await f.bridge.pump();
    console.log(JSON.stringify({installation:index+1,independent_database:true,events:f.calls.filter(c=>c.body.eventId).length,replies:f.sent.length}));
  }
  console.log('MOCK ONLY: independent personal hosts; no real keys, Tunnel, Feishu or dot connection.');
} finally {for(const f of installs)f.store.close();}
