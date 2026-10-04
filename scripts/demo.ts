/** Offline MOCK integration demonstration. This is NOT a real dot or Feishu session. */
import { fixture } from '../test/fixtures.js';
const f = fixture();
try {
  f.bind(); f.bind(f.bob, { openId: 'ou_bob', chatId: 'oc_bob' });
  await f.subscribe(); await f.subscribe(f.bob);
  f.bridge.receive(f.message({ text: '你好，我是 Alice' }));
  f.bridge.receive(f.message({ messageId: 'om_bob', openId: 'ou_bob', chatId: 'oc_bob', text: '你好，我是 Bob' }));
  await f.bridge.pump();
  for (const c of f.calls.filter(c => c.body.eventId)) {
    const owner = c.url.endsWith('alice') ? f.alice : f.bob;
    f.bridge.reply(owner, { event_id: c.body.eventId, text: `[MOCK dot] 收到 ${owner === f.alice ? 'Alice' : 'Bob'} 的消息` });
  }
  await f.bridge.pump();
  console.log('MOCK ONLY: 2 independent users bound, 2 signed events delivered, 2 replies routed');
  for (const s of f.sent) console.log(JSON.stringify({ original_message: s.messageId, mock_reply: s.text }));
  console.log('No real credentials, Feishu API, ChatGPT account, or network connection was used.');
} finally { f.store.close(); }
