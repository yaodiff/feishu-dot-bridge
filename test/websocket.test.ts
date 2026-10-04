/** MOCK WS driver + real official EventDispatcher. No live SDK connection/credentials. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type * as lark from '@larksuiteoapi/node-sdk';
import { fixture, feishuPayload, mockApp } from './fixtures.js';
import { decodeFeishuWebSocket } from '../src/feishu.js';
import { FeishuWebSocketIngress, authenticatedWebSocketMessageHandler, type WebSocketFactory, type WebSocketHooks } from '../src/feishu-websocket.js';
import { loadFeishuApps } from '../src/feishu-config.js';
import { makeApp } from '../src/http.js';
import type { FeishuApp, Inbound } from '../src/types.js';
const wsApp: FeishuApp = { ...mockApp, appId: 'cli_0000000000000001', ingress: 'websocket', websocketExclusiveConsumer: true, encryptKey: '', verificationToken: '' };
function rawPayload(text = 'MOCK WS message', overrides: Parameters<typeof feishuPayload>[1] = {}) { return feishuPayload(text, { appId: wsApp.appId, ...overrides }); }
function flattened(text = 'MOCK WS message', overrides: Parameters<typeof feishuPayload>[1] = {}) { const p = rawPayload(text, overrides); return { ...p.header, ...p.event, schema: p.schema }; }
function mockDriver(autoReady = true) {
  let starts = 0, closes = 0, hooks: WebSocketHooks | undefined, dispatcher: lark.EventDispatcher | undefined;
  const factory: WebSocketFactory = (_app, h) => { hooks = h; return {
    async start(options) { starts++; dispatcher = options.eventDispatcher; if (autoReady) h.ready(); },
    close() { closes++; }, getConnectionStatus() { return { state: 'connected' }; }
  }; };
  return { factory, starts: () => starts, closes: () => closes, hooks: () => hooks!, dispatcher: () => dispatcher! };
}

test('WS config is explicit; webhook remains default and only its secrets are required', () => {
  const used: string[] = []; const secret = (name: string) => { used.push(name); return 'MOCK_ONLY'; };
  const webhook = loadFeishuApps([{ appId: 'cli_mock', tenantKey: 'tenant', appSecretEnv: 'APP_SECRET', encryptKeyEnv: 'ENCRYPT_KEY', verificationTokenEnv: 'VERIFY_TOKEN' }], secret);
  assert.equal(webhook[0]!.ingress, 'webhook'); assert.deepEqual(used, ['APP_SECRET', 'ENCRYPT_KEY', 'VERIFY_TOKEN']); used.length = 0;
  const ws = { appId: wsApp.appId, tenantKey: wsApp.tenantKey, appSecretEnv: 'APP_SECRET', ingress: 'websocket', websocketExclusiveConsumer: true };
  assert.equal(loadFeishuApps([ws], secret)[0]!.encryptKey, ''); assert.deepEqual(used, ['APP_SECRET']);
  assert.throws(() => loadFeishuApps([{ ...ws, websocketExclusiveConsumer: false }], secret));
  assert.throws(() => loadFeishuApps([{ ...ws, websocketExclusiveConsumer: undefined }], secret));
  assert.throws(() => loadFeishuApps([ws, ws], secret), /Duplicate app/);
  assert.throws(() => loadFeishuApps([{ ...ws, ingress: 'webhook' }], secret));
});

test('WS mapping requires trusted app/tenant identity, event type, sender and DM text', () => {
  const good = decodeFeishuWebSocket(wsApp, flattened()); assert.ok('message' in good);
  if ('message' in good) assert.deepEqual({ app: good.message.appId, tenant: good.message.tenantKey, sender: good.message.openId }, { app: wsApp.appId, tenant: wsApp.tenantKey, sender: 'ou_alice' });
  for (const bad of [flattened('x', { appId: 'cli_spoof' }), flattened('x', { tenant: 'other_tenant' }), { ...flattened(), app_id: undefined }, { ...flattened(), tenant_key: undefined }, { ...flattened(), event_type: 'card.action.trigger' }]) assert.throws(() => decodeFeishuWebSocket(wsApp, bad));
  const badSender = flattened(); badSender.sender.tenant_key = 'other_tenant'; assert.throws(() => decodeFeishuWebSocket(wsApp, badSender), /identity/);
  assert.throws(() => decodeFeishuWebSocket(mockApp, flattened()), /wrong_feishu_transport/);
  for (const overrides of [{ sender: 'bot' }, { sender: 'system' }, { chatType: 'group' }, { type: 'audio' }]) assert.deepEqual(decodeFeishuWebSocket(wsApp, flattened('x', overrides)), { ignored: true });
  const stale = flattened(); stale.message.create_time = String(Date.now() - 25 * 3600000); assert.deepEqual(decodeFeishuWebSocket(wsApp, stale), { ignored: true });
});

test('WS SDK dispatcher feeds the existing binding/inbox/dedupe/outbox without HTTP signatures', async () => {
  const f = fixture(), driver = mockDriver(); const ingress = new FeishuWebSocketIngress([wsApp], m => f.bridge.receive(m), { factory: driver.factory });
  try {
    await ingress.start();
    // Official WS DataCache yields parsed JSON; RequestHandle flattens header + event.
    const dispatch = async (p: unknown) => driver.dispatcher().invoke(p, { needCheck: false });
    const command = f.bridge.beginBinding(f.alice).command;
    await dispatch(rawPayload(command, { messageId: 'om_ws_pair' })); assert.equal(f.store.binding(f.alice.id)!.appId, wsApp.appId);
    await f.subscribe();
    const message = rawPayload('hello over WS', { messageId: 'om_ws_text' }); await dispatch(message); await dispatch(message);
    await f.bridge.pump(); assert.equal(f.calls.filter(c => c.body.eventId).length, 1);
    const eventId = f.calls.find(c => c.body.eventId)!.body.eventId; f.bridge.reply(f.alice, { event_id: eventId, text: 'MOCK response' }); await f.bridge.pump();
    assert.deepEqual(f.sent.map(s => [s.appId, s.messageId]), [[wsApp.appId, 'om_ws_text']]);
  } finally { ingress.stop(); f.store.close(); }
});

test('WS plaintext cannot be posted through HTTP, even with a matching app path', async () => {
  const f = fixture(); const app = makeApp({ publicUrl: 'https://bridge.example', issuer: 'https://idp.example', apps: [wsApp], allowedOrigins: [] }, f.bridge, { async authenticate() { return f.alice; } });
  try {
    const response = await app(new Request(`https://bridge.example/feishu/events/${wsApp.appId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rawPayload('/bind spoof')) }));
    assert.equal(response.status, 404); assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM receipts').get()!.n, 0);
  } finally { f.store.close(); }
});

test('WS start is idempotent and excludes duplicate app workers across ingress instances', async () => {
  const driver = mockDriver(), other = mockDriver(), messages: Inbound[] = [];
  const a = new FeishuWebSocketIngress([wsApp], m => messages.push(m), { factory: driver.factory });
  const b = new FeishuWebSocketIngress([wsApp], () => {}, { factory: other.factory });
  try {
    const one = a.start(), two = a.start(); assert.equal(one, two); await Promise.all([one, two]); assert.equal(driver.starts(), 1);
    await assert.rejects(b.start(), /duplicate_ws_consumer/); assert.equal(other.starts(), 0);
    a.stop(); a.stop(); assert.equal(driver.closes(), 1);
    await driver.dispatcher().invoke(rawPayload(), { needCheck: false }); assert.equal(messages.length, 0);
    const replacement = new FeishuWebSocketIngress([wsApp], () => {}, { factory: other.factory }); try { await replacement.start(); assert.equal(other.starts(), 1); } finally { replacement.stop(); }
  } finally { a.stop(); b.stop(); }
});

test('WS readiness waits for onReady, times out safely and releases worker reservation', async () => {
  const driver = mockDriver(false); const a = new FeishuWebSocketIngress([wsApp], () => {}, { factory: driver.factory, startupTimeoutMs: 15 });
  await assert.rejects(a.start(), /ws_start_timeout/); assert.equal(driver.closes(), 1);
  const next = mockDriver(false), b = new FeishuWebSocketIngress([wsApp], () => {}, { factory: next.factory, startupTimeoutMs: 1000 });
  try {
    let ready = false; const start = b.start().then(() => { ready = true; }); await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(ready, false);
    next.hooks().ready(); await start; assert.equal(ready, true);
  } finally { b.stop(); }
});

test('WS stopping during connection prevents late handshake/dispatch from resuming work', async () => {
  const driver = mockDriver(false); let received = 0;
  const ingress = new FeishuWebSocketIngress([wsApp], () => { received++; }, { factory: driver.factory });
  const startup = ingress.start(); const rejected = assert.rejects(startup, /ws_ingress_stopped/);
  await new Promise(resolve => setTimeout(resolve, 5)); ingress.stop(); driver.hooks().ready(); await rejected;
  await driver.dispatcher().invoke(rawPayload(), { needCheck: false }); assert.equal(received, 0); assert.equal(driver.closes(), 1);
});

test('WS rejects bad events quietly but surfaces persistence failure for SDK retry', async () => {
  const notices: string[] = []; const accept = authenticatedWebSocketMessageHandler(wsApp, () => { throw new Error('MOCK DB failure containing private details'); }, { notice: event => notices.push(event) });
  await accept(flattened('x', { tenant: 'wrong' })); assert.deepEqual(notices, ['ws_event_rejected']);
  await assert.rejects(accept(flattened()), /ws_storage_failed/); assert.deepEqual(notices, ['ws_event_rejected', 'ws_storage_failed']);
});

test('WS startup failure rolls back every reserved app without creating duplicate workers', async () => {
  const secondApp = { ...wsApp, appId: 'cli_0000000000000002' };
  const driver = mockDriver();
  const failed = new FeishuWebSocketIngress([wsApp, secondApp], () => {}, { factory: (app, hooks) => { if (app.appId === secondApp.appId) throw new Error('MOCK factory failure'); return driver.factory(app, hooks); } });
  await assert.rejects(failed.start(), /ws_start_failed/); assert.equal(driver.closes(), 1);
  const restarted = new FeishuWebSocketIngress([wsApp, secondApp], () => {}, { factory: driver.factory });
  try { await restarted.start(); assert.equal(driver.starts(), 3); } finally { restarted.stop(); }
});

test('WS handler awaits asynchronous persistence before acknowledging', async () => {
  let persisted = false;
  const handler = authenticatedWebSocketMessageHandler(wsApp, async () => { await new Promise(resolve => setTimeout(resolve, 5)); persisted = true; });
  const result = handler(flattened()); assert.equal(persisted, false); await result; assert.equal(persisted, true);
  const failing = authenticatedWebSocketMessageHandler(wsApp, async () => { throw new Error('private failure'); });
  await assert.rejects(failing(flattened()), /ws_storage_failed/);
});

test('a ready app failing during aggregate startup rejects startup and closes all apps', async () => {
  const appB = { ...wsApp, appId: 'cli_0000000000000002' }, a = mockDriver(false), b = mockDriver(false); let received = 0;
  const ingress = new FeishuWebSocketIngress([wsApp, appB], () => { received++; }, { factory: (app, hooks) => (app.appId === wsApp.appId ? a : b).factory(app, hooks) });
  const startup = ingress.start(); const rejected = assert.rejects(startup, /ws_start_failed/);
  await new Promise(resolve => setTimeout(resolve, 5));
  a.hooks().ready(); a.hooks().failed(); b.hooks().ready();
  await rejected; assert.equal(a.closes(), 1); assert.equal(b.closes(), 1);
  assert.deepEqual(ingress.status().map(s => s.state), ['stopped', 'stopped']);
  // Stale callbacks cannot resurrect either entry after rollback.
  a.hooks().ready(); b.hooks().reconnected();
  await a.dispatcher().invoke(rawPayload(), { needCheck: false }); assert.equal(received, 0);
  const replacement = new FeishuWebSocketIngress([wsApp, appB], () => {}, { factory: mockDriver().factory });
  try { await replacement.start(); } finally { replacement.stop(); }
});

test('terminal SDK failure after startup closes ingress and invokes host failure hook once', async () => {
  const driver = mockDriver(); let terminal = 0, received = 0;
  const ingress = new FeishuWebSocketIngress([wsApp], () => { received++; }, { factory: driver.factory, onTerminalFailure: () => { terminal++; } });
  await ingress.start();
  driver.hooks().reconnecting(); assert.equal(terminal, 0); assert.equal(driver.closes(), 0);
  driver.hooks().reconnected(); assert.equal(terminal, 0);
  driver.hooks().failed(); assert.equal(terminal, 1); assert.equal(driver.closes(), 1);
  assert.equal(ingress.status()[0]!.state, 'stopped');
  driver.hooks().failed(); driver.hooks().ready(); driver.hooks().reconnected(); assert.equal(terminal, 1);
  await driver.dispatcher().invoke(rawPayload(), { needCheck: false }); assert.equal(received, 0);
  await assert.rejects(ingress.start(), /ws_ingress_stopped/);
});
