/** Synthetic MCP requests with fixed fake principals, no external network calls. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, mockApp } from './fixtures.js';
import { personalFixture, MOCK_TOKEN_A } from './personal-fixtures.js';
import { makeApp } from '../src/http.js';
import { BridgeError } from '../src/types.js';
const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'MOCK-mirror', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} };
for (const mode of ['oauth', 'personal-tunnel'] as const) test(`${mode}: new tools authenticate and preserve strict input, annotations and existing tools`, async () => {
  const personal = mode === 'personal-tunnel' ? personalFixture() : undefined;
  const f = personal ?? fixture(), owner = personal?.owner ?? f.alice;
  f.sender.sendBound = async () => 'om_MOCK';
  const auth = personal?.auth ?? { async authenticate(header: string | null) { if (header !== 'Bearer MOCK_OWNER') throw new BridgeError('unauthorized', 401); return owner; } };
  const app = makeApp({ authMode: mode, publicUrl: 'http://127.0.0.1', issuer: 'https://MOCK.invalid', apps: [mockApp], allowedOrigins: [] }, f.bridge, auth);
  const authHeaders: Record<string, string> = personal ? { 'X-Bridge-Token': MOCK_TOKEN_A } : { authorization: 'Bearer MOCK_OWNER' };
  const rpc = async (method: string, params: Record<string, unknown> = {}, authorized = true) => app(new Request('http://127.0.0.1/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json,text/event-stream', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method, ...(method === 'tools/call' ? { 'Mcp-Name': String(params.name) } : {}), ...(authorized ? authHeaders : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: meta } }) }));
  const call = async (name: string, args: unknown) => (await (await rpc('tools/call', { name, arguments: args })).json()).result;
  try {
    f.bind(owner); const binding = f.store.binding(owner.id)!;
    const catalog = (await (await rpc('tools/list')).json()).result.tools;
    assert.equal(catalog.length, 16);
    for (const name of ['begin_binding','binding_status','unlink_binding','reply_to_feishu','delivery_status','get_event','list_pending_events']) assert.ok(catalog.find((t: { name: string }) => t.name === name));
    for (const [name, read] of [['send_to_bound_feishu', false], ['mirror_delivery_status', true]] as const) {
      const tool = catalog.find((t: { name: string }) => t.name === name); assert.ok(tool);
      assert.equal(tool.inputSchema.additionalProperties, false); assert.equal(tool.annotations.readOnlyHint, read); assert.equal(tool.annotations.idempotentHint, true);
      assert.deepEqual(tool.securitySchemes, personal ? [{ type: 'noauth' }] : [{ type: 'oauth2', scopes: ['bridge:use'] }]);
    }
    const args = { binding_id: binding.id, source_message_id: 'MOCK_message', source_role: 'assistant', text: '普通排查信息：请求失败，状态码 502' };
    assert.equal((await rpc('tools/call', { name: 'send_to_bound_feishu', arguments: args }, false)).status, 401);
    const denied = await call('send_to_bound_feishu', { ...args, chat_id: 'oc_ATTACKER' }); assert.equal(denied.isError, true); assert.equal(denied.content[0].text, 'invalid_request');
    const result = await call('send_to_bound_feishu', args); assert.ok(!result.isError); const queued = JSON.parse(result.content[0].text); assert.equal(queued.state, 'pending');
    await f.bridge.pump(); const status = JSON.parse((await call('mirror_delivery_status', { sync_id: queued.sync_id })).content[0].text); assert.equal(status.state, 'sent');
    assert.ok(!JSON.stringify(status).includes(args.text)); assert.ok(!JSON.stringify(status).includes(binding.chatId));
    const unknown = await call('mirror_delivery_status', { sync_id: 'unknown' }); assert.equal(unknown.content[0].text, 'sync_not_found');
    const omitted = JSON.parse((await call('send_to_bound_feishu', { ...args, source_message_id: 'MOCK_credential', text: 'password=MOCK_NOT_REAL_PASSWORD' })).content[0].text);
    assert.equal(omitted.content_status, 'credential_blocked'); assert.ok(!JSON.stringify(omitted).includes('MOCK_NOT_REAL_PASSWORD'));
  } finally { f.store.close(); }
});
