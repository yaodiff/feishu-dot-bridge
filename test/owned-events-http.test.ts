/** Synthetic auth and loopback HTTP only; no production credentials or network services. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, nodeServer } from '../src/http.js';
import { BridgeError } from '../src/types.js';
import { encryptedCallback, feishuPayload, fixture, mockApp } from './fixtures.js';
import { MOCK_TOKEN_A, personalFixture } from './personal-fixtures.js';
const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'MOCK-read-client', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} };
function request(method: string, params: Record<string, unknown>, auth: Record<string, string>) {
  return { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method, ...(method === 'tools/call' ? { 'Mcp-Name': String(params.name) } : {}), ...auth }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: meta } }) };
}
for (const mode of ['oauth', 'personal-tunnel'] as const) test(`${mode}: authenticated loopback MCP discovery, pending list, exact get, pagination, auth and strict arguments`, async () => {
  const personal = mode === 'personal-tunnel' ? personalFixture() : undefined;
  const f = personal ?? fixture(), owner = personal?.owner ?? f.alice;
  const auth = personal?.auth ?? { async authenticate(header: string | null) { if (header !== 'Bearer MOCK_OWNER') throw new BridgeError('unauthorized', 401); return owner; } };
  const headers: Record<string, string> = personal ? { 'X-Bridge-Token': MOCK_TOKEN_A } : { authorization: 'Bearer MOCK_OWNER' };
  const app = makeApp({ authMode: mode, publicUrl: 'http://127.0.0.1', issuer: 'https://MOCK-idp.invalid', apps: [mockApp], allowedOrigins: [] }, f.bridge, auth);
  const allowed: string[] = [], server = nodeServer(app, 'http://127.0.0.1', allowed);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port; allowed.push(`127.0.0.1:${port}`); const origin = `http://127.0.0.1:${port}`;
  const rpc = (method: string, params: Record<string, unknown> = {}, authHeaders = headers) => fetch(origin + '/mcp', request(method, params, authHeaders));
  const call = async (name: string, args: unknown = {}) => (await (await rpc('tools/call', { name, arguments: args })).json()).result;
  const callback = async (text: string, messageId: string) => { const payload = feishuPayload(text, { messageId }); payload.event.message.create_time = String(f.now()); const c = encryptedCallback(payload); assert.equal((await fetch(origin + '/feishu/events/cli_mock', { method: 'POST', headers: c.headers, body: c.raw })).status, 200); };
  try {
    const discover = await (await rpc('server/discover')).json(); assert.deepEqual(discover.result.capabilities.tools, {});
    const catalog = await (await rpc('tools/list')).json(); assert.equal(catalog.result.tools.length, 16);
    for (const name of ['list_pending_events', 'get_event']) {
      const tool = catalog.result.tools.find((t: { name: string }) => t.name === name); assert.ok(tool);
      assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
      assert.deepEqual(tool.securitySchemes, personal ? [{ type: 'noauth' }] : [{ type: 'oauth2', scopes: ['bridge:use'] }]);
      assert.match(tool.description, /untrusted/); assert.match(tool.description, /existing user authorization/);
      assert.equal(tool.inputSchema.additionalProperties, false);
    }
    const listSchema = catalog.result.tools.find((t: { name: string }) => t.name === 'list_pending_events').inputSchema;
    assert.ok(!(listSchema.required ?? []).includes('limit')); assert.equal(listSchema.properties.limit.default, 10); assert.equal(listSchema.properties.limit.maximum, 20);
    for (const name of ['list_pending_events', 'get_event']) assert.equal((await rpc('tools/call', { name, arguments: name === 'get_event' ? { event_id: 'unknown' } : {} }, {})).status, 401);
    const pair = JSON.parse((await call('begin_binding')).content[0].text); await callback(pair.command, 'MOCK_HTTP_BIND');
    await callback('MOCK recovered wake text', 'MOCK_HTTP_READ_1'); await callback('MOCK second text', 'MOCK_HTTP_READ_2');
    const first = JSON.parse((await call('list_pending_events', { limit: 1 })).content[0].text);
    assert.equal(first.events.length, 1); assert.equal(first.events[0].text, 'MOCK recovered wake text'); assert.equal(typeof first.next_cursor, 'string');
    assert.deepEqual(Object.keys(first.events[0]).sort(), ['event_id', 'text', 'timestamp']);
    const omitted = await (await rpc('tools/call', { name: 'list_pending_events' })).json(); assert.equal(JSON.parse(omitted.result.content[0].text).events.length, 2);
    const next = JSON.parse((await call('list_pending_events', { cursor: first.next_cursor })).content[0].text); assert.equal(next.events[0].text, 'MOCK second text'); assert.equal(next.next_cursor, null);
    const found = JSON.parse((await call('get_event', { event_id: first.events[0].event_id })).content[0].text);
    assert.deepEqual(found, { ...first.events[0], reply: { state: 'not_queued', attempts: 0 } });
    for (const [name, args] of [['list_pending_events', { limit: 21 }], ['list_pending_events', { owner: 'other' }], ['list_pending_events', { cursor: 'x'.repeat(1025) }], ['get_event', { event_id: first.events[0].event_id, chat_id: 'other' }]]) {
      const result = await call(name as string, args); assert.equal(result.isError, true); assert.equal(result.content[0].text, 'invalid_request');
    }
    const invalidCursor = await call('list_pending_events', { cursor: 'unknown' }); assert.equal(invalidCursor.content[0].text, 'invalid_cursor');
    const missing = await call('get_event', { event_id: 'unknown' }); assert.equal(missing.content[0].text, 'event_not_found');
    assert.equal(f.sent.length, 0); assert.equal(f.calls.length, 0);
    await call('reply_to_feishu', { event_id: first.events[0].event_id, text: 'MOCK previously authorized reply' });
    assert.equal(JSON.parse((await call('list_pending_events')).content[0].text).events.length, 1);
    assert.deepEqual(JSON.parse((await call('get_event', { event_id: first.events[0].event_id })).content[0].text).reply, { state: 'pending', attempts: 0 });
    await f.bridge.pump(); assert.equal(f.sent.length, 1);
    assert.deepEqual(JSON.parse((await call('get_event', { event_id: first.events[0].event_id })).content[0].text).reply, { state: 'sent', attempts: 1 });
    if (!personal) { owner.expiresAt = f.now(); const expired = await call('get_event', { event_id: first.events[0].event_id }); assert.equal(expired.content[0].text, 'unauthorized'); owner.expiresAt = f.now() + 3600000; }
    f.store.revoke(owner.id);
    for (const name of ['list_pending_events', 'get_event']) assert.equal((await rpc('tools/call', { name, arguments: name === 'get_event' ? { event_id: first.events[0].event_id } : {} })).status, 401);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); f.store.close(); }
});
