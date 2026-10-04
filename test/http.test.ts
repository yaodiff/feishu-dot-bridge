import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp } from '../src/http.js';
import { BridgeError } from '../src/types.js';
import { encryptedCallback, feishuPayload, fixture, mockApp } from './fixtures.js';
const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'MOCK-test-client', version: '0.0.0' }, 'io.modelcontextprotocol/clientCapabilities': {} };
function rpc(method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) { return new Request('https://bridge.example/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer MOCK_ALICE', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method, ...(typeof params.name === 'string' && method === 'tools/call' ? { 'Mcp-Name': params.name } : {}), ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: meta } }) }); }
test('MOCK HTTP integration uses actual MCP v2 SDK and signed/encrypted Feishu callbacks', async () => {
  const f = fixture(); const app = makeApp({ publicUrl: 'https://bridge.example', issuer: 'https://idp.example', apps: [mockApp], allowedOrigins: ['https://chatgpt.com'] }, f.bridge, { async authenticate(token) { if (token !== 'Bearer MOCK_ALICE') throw new BridgeError('unauthorized', 401); return f.alice; } });
  try {
    const metadata = await app(new Request('https://bridge.example/.well-known/oauth-protected-resource/mcp')); assert.equal((await metadata.json()).resource, 'https://bridge.example/mcp');
    const noAuth = await app(rpc('server/discover', {}, { authorization: '' })); assert.equal(noAuth.status, 401); assert.match(noAuth.headers.get('www-authenticate')!, /resource_metadata/);
    const discover = await app(rpc('server/discover')); const discovered = await discover.json(); assert.equal(discover.status, 200, JSON.stringify(discovered)); assert.deepEqual(discovered.result.capabilities.events, {}); assert.equal(discovered.result.resultType, 'complete');
    const list = await (await app(rpc('tools/list'))).json(); assert.equal(list.result.tools.length, 5);
    const pairing = await (await app(rpc('tools/call', { name: 'begin_binding', arguments: {} }))).json(); const command = JSON.parse(pairing.result.content[0].text).command;
    assert.ok(command, JSON.stringify(pairing));
    const c = encryptedCallback(feishuPayload(command, { messageId: 'om_pair' })); assert.equal((await app(new Request('https://bridge.example/feishu/events/cli_mock', { method: 'POST', headers: c.headers, body: c.raw }))).status, 200);
    const status = await (await app(rpc('tools/call', { name: 'binding_status', arguments: {} }))).json(); const bindingId = JSON.parse(status.result.content[0].text).binding_id; assert.ok(bindingId);
    const events = await (await app(rpc('events/list'))).json(); assert.equal(events.result.events[0].name, 'feishu.message.created', JSON.stringify(events));
    const subscribe = await (await app(rpc('events/subscribe', { name: 'feishu.message.created', arguments: { binding_id: bindingId }, delivery: { mode: 'webhook', url: 'https://callback.example/dot/alice', secret: f.secret }, cursor: null }))).json(); assert.ok(subscribe.result.id, JSON.stringify(subscribe));
    const msg = encryptedCallback(feishuPayload('HTTP roundtrip', { messageId: 'om_roundtrip' })); await app(new Request('https://bridge.example/feishu/events/cli_mock', { method: 'POST', headers: msg.headers, body: msg.raw })); await f.bridge.pump();
    const eventId = f.calls.find(c => c.body.eventId)!.body.eventId;
    const reply = await (await app(rpc('tools/call', { name: 'reply_to_feishu', arguments: { event_id: eventId, text: 'Response from MOCK dot' } }))).json(); assert.equal(reply.result.isError, undefined, JSON.stringify(reply)); await f.bridge.pump(); assert.equal(f.sent[0]!.messageId, 'om_roundtrip');
    const stop = await (await app(rpc('events/unsubscribe', { name: 'feishu.message.created', arguments: { binding_id: bindingId }, delivery: { mode: 'webhook', url: 'https://callback.example/dot/alice' } }))).json(); assert.equal(stop.result.resultType, 'complete');
  } finally { f.store.close(); }
});
test('MCP rejects wrong Origin, header/body mismatch, legacy protocol and arbitrary tool arguments', async () => {
  const f = fixture(); const app = makeApp({ publicUrl: 'https://bridge.example', issuer: 'https://idp.example', apps: [], allowedOrigins: ['https://chatgpt.com'] }, f.bridge, { async authenticate() { return f.alice; } });
  try {
    assert.equal((await app(rpc('server/discover', {}, { origin: 'https://evil.example' }))).status, 403);
    assert.equal((await app(rpc('tools/list', {}, { 'Mcp-Method': 'tools/call' }))).status, 400);
    assert.equal((await app(rpc('tools/list', {}, { 'MCP-Protocol-Version': '2025-11-25' }))).status, 400);
    assert.equal((await app(new Request('https://bridge.example/mcp'))).status, 405);
    const bad = await (await app(rpc('tools/call', { name: 'begin_binding', arguments: { owner_id: 'victim' } }))).json(); assert.equal(bad.result.isError, true);
  } finally { f.store.close(); }
});
