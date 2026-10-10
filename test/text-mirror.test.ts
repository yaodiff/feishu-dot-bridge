/** Synthetic source IDs, fake bindings, in-memory/local temp databases and mock senders only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { fixture, encryptedCallback, feishuPayload, mockApp } from './fixtures.js';
import { Bridge, OMITTED_CREDENTIAL_TEXT, UNSUPPORTED_CONTENT_TEXT } from '../src/bridge.js';
import { Store } from '../src/store.js';
import { SecretBox, hash } from '../src/crypto.js';
import { decodeFeishu, LarkSender } from '../src/feishu.js';
const syntheticCredential = 'password=MOCK_ONLY_ThisIsNotARealCredential';
function mirrorFixture(path = ':memory:') {
  const f = fixture(path); const deliveries: { appId: string; chatId: string; text: string; key: string }[] = [];
  f.sender.sendBound = async (appId, chatId, text, key) => { deliveries.push({ appId, chatId, text, key }); return `om_MOCK_${deliveries.length}`; };
  const binding = f.bind();
  const input = (source_message_id = 'MOCK_chatgpt_1', text = '排查连接失败：状态为 502，下一步检查请求是否超时') => ({ binding_id: binding.id, source_message_id, source_role: 'user' as const, text });
  return { ...f, binding, deliveries, input };
}
test('owner-bound sends enforce routing, strict parameters, source labels, status privacy and immutable idempotency', async () => {
  const f = mirrorFixture(); try {
    const args = f.input(); const queued = f.bridge.sendToBoundFeishu(f.alice, args);
    assert.equal(queued.state, 'pending'); assert.deepEqual(f.bridge.sendToBoundFeishu(f.alice, args), queued);
    for (const other of [{ ...args, text: 'changed' }, { ...args, source_role: 'assistant' }]) assert.throws(() => f.bridge.sendToBoundFeishu(f.alice, other), /source_already_reserved/);
    for (const other of [{ ...args, chat_id: 'oc_victim' }, { ...args, owner: 'victim' }, { ...args, source_role: 'system' }, { ...args, source_message_id: '' }]) assert.throws(() => f.bridge.sendToBoundFeishu(f.alice, other));
    assert.throws(() => f.bridge.sendToBoundFeishu(f.bob, args), /binding_not_found/);
    assert.throws(() => f.bridge.sendToBoundFeishu({ ...f.alice, expiresAt: f.now() }, args), /unauthorized/);
    assert.throws(() => f.bridge.mirrorDeliveryStatus(f.bob, { sync_id: queued.sync_id }), /sync_not_found/);
    assert.throws(() => f.bridge.mirrorDeliveryStatus(f.alice, { sync_id: 'unknown' }), /sync_not_found/);
    await Promise.all([f.bridge.pump(), f.bridge.pump()]); assert.equal(f.deliveries.length, 1);
    assert.equal(f.deliveries[0]!.chatId, f.binding.chatId); assert.equal(f.deliveries[0]!.appId, f.binding.appId);
    assert.equal(f.deliveries[0]!.text, '[来自 ChatGPT · 你]\n' + args.text);
    assert.equal(f.deliveries[0]!.key, hash(queued.sync_id).slice(0, 32));
    const sent = f.bridge.mirrorDeliveryStatus(f.alice, { sync_id: queued.sync_id });
    assert.equal(sent.state, 'sent'); assert.equal(sent.message_id, 'om_MOCK_1');
    assert.deepEqual(Object.keys(sent).sort(), ['attempts', 'message_id', 'state', 'sync_id']);
    assert.equal(f.bridge.sendToBoundFeishu(f.alice, args).state, 'sent'); await f.bridge.pump(); assert.equal(f.deliveries.length, 1);
  } finally { f.store.close(); }
});
test('outbound credentials become fixed omission notices before storage; plain diagnostics remain intact', async () => {
  const f = mirrorFixture(); try {
    const queued = f.bridge.sendToBoundFeishu(f.alice, f.input('secret', syntheticCredential));
    assert.equal(queued.content_status, 'credential_blocked');
    const rows = JSON.stringify(f.store.db.prepare('SELECT * FROM mirror_outbox').all());
    assert.ok(!rows.includes('ThisIsNotARealCredential')); assert.ok(rows.includes(OMITTED_CREDENTIAL_TEXT));
    await f.bridge.pump(); assert.equal(f.deliveries[0]!.text, '[来自 ChatGPT · 你]\n' + OMITTED_CREDENTIAL_TEXT);
    const normal = f.input('diagnostic'); f.bridge.sendToBoundFeishu(f.alice, normal); await f.bridge.pump(); assert.ok(f.deliveries[1]!.text.endsWith(normal.text));
  } finally { f.store.close(); }
});
test('ingress credentials and unsupported media retain only safe notices and explicit content status', async () => {
  const f = mirrorFixture(); try {
    await f.subscribe();
    const cp = feishuPayload(syntheticCredential, { messageId: 'credential' }); cp.event.message.create_time = String(f.now());
    const credential = encryptedCallback(cp);
    const decoded = decodeFeishu(mockApp, credential.raw, new Headers(credential.headers)); assert.ok('message' in decoded);
    if (!('message' in decoded)) throw new Error(); assert.equal(decoded.message.text, OMITTED_CREDENTIAL_TEXT); f.bridge.receive(decoded.message);
    const mp = feishuPayload('/bind DO_NOT_PARSE_MEDIA_BODY', { type: 'audio', messageId: 'media' }); mp.event.message.create_time = String(f.now());
    const media = encryptedCallback(mp);
    const unsupported = decodeFeishu(mockApp, media.raw, new Headers(media.headers)); assert.ok('message' in unsupported);
    if (!('message' in unsupported)) throw new Error(); assert.equal(unsupported.message.text, UNSUPPORTED_CONTENT_TEXT); f.bridge.receive(unsupported.message);
    // Trusted adapters cannot bypass the ingress gate by setting text directly.
    f.bridge.receive(f.message({ messageId: 'direct', text: syntheticCredential }));
    const events = f.bridge.listPendingEvents(f.alice, {}).events; assert.equal(events.length, 3);
    assert.deepEqual(events.map(e => e.content_status), ['credential_blocked', 'unsupported', 'credential_blocked']);
    assert.equal(f.bridge.getEvent(f.alice, { event_id: events[0]!.event_id }).content_status, 'credential_blocked');
    assert.ok(!JSON.stringify(f.store.db.prepare('SELECT * FROM inbox').all()).includes('ThisIsNotARealCredential'));
    assert.ok(!JSON.stringify(f.store.db.prepare('SELECT * FROM jobs').all()).includes('ThisIsNotARealCredential'));
    await f.bridge.pump(); const payloads = f.calls.filter(c => c.body.eventId); assert.equal(payloads.length, 3);
    assert.equal(payloads[1]!.body.data.content_status, 'unsupported'); assert.ok(!JSON.stringify(payloads).includes('DO_NOT_PARSE_MEDIA_BODY'));
    f.bridge.reply(f.alice, { event_id: events[0]!.event_id, text: syntheticCredential }); await f.bridge.pump(); assert.equal(f.sent[0]!.text, OMITTED_CREDENTIAL_TEXT);
  } finally { f.store.close(); }
});
test('rebind, revocation and identity tampering cancel pending work and never reroute an old generation', async () => {
  const f = mirrorFixture(); try {
    const old = f.bridge.sendToBoundFeishu(f.alice, f.input()); f.bridge.unlink(f.alice); const next = f.bind(f.alice, { chatId: 'oc_NEW' });
    assert.throws(() => f.bridge.sendToBoundFeishu(f.alice, f.input()), /binding_not_found/);
    assert.throws(() => f.bridge.mirrorDeliveryStatus(f.alice, { sync_id: old.sync_id }), /sync_not_found/);
    await f.bridge.pump(); assert.equal(f.deliveries.length, 0); assert.equal(f.store.mirrorJob(old.sync_id)!.state, 'cancelled');
    const current = f.bridge.sendToBoundFeishu(f.alice, { ...f.input('current'), binding_id: next.id });
    f.store.db.prepare('UPDATE mirror_outbox SET chatId=? WHERE id=?').run('oc_ATTACKER', current.sync_id);
    assert.throws(() => f.bridge.mirrorDeliveryStatus(f.alice, { sync_id: current.sync_id }), /sync_not_found/);
    await f.bridge.pump(); assert.equal(f.deliveries.length, 0); assert.equal(f.store.mirrorJob(current.sync_id)!.state, 'cancelled');
    const revoked = f.bridge.sendToBoundFeishu(f.alice, { ...f.input('revoked'), binding_id: next.id }); f.store.revoke(f.alice.id); await f.bridge.pump();
    assert.equal(f.store.mirrorJob(revoked.sync_id)!.state, 'cancelled'); assert.equal(f.deliveries.length, 0);
  } finally { f.store.close(); }
});
test('retry backoff preserves mirror lane order and UUID, then ambiguous exhaustion stops uncertain', async () => {
  const f = mirrorFixture(); try {
    const a = f.bridge.sendToBoundFeishu(f.alice, f.input('a')), b = f.bridge.sendToBoundFeishu(f.alice, f.input('b'));
    const keys: string[] = []; let fail = true;
    f.sender.sendBound = async (_app, _chat, _text, key) => { keys.push(key); if (fail) throw new Error('MOCK timeout'); return 'om_MOCK'; };
    await f.bridge.pump(); assert.equal(keys.length, 1); await f.bridge.pump(); assert.equal(keys.length, 1);
    f.advance(1001); fail = false; await f.bridge.pump(); assert.deepEqual(keys, [hash(a.sync_id).slice(0, 32), hash(a.sync_id).slice(0, 32), hash(b.sync_id).slice(0, 32)]);
    const c = f.bridge.sendToBoundFeishu(f.alice, f.input('c')); fail = true;
    for (let i = 0; i < 8; i++) { await f.bridge.pump(); f.advance(1000 * 2 ** i + 1); }
    assert.equal(f.store.mirrorJob(c.sync_id)!.state, 'uncertain'); assert.equal(f.store.mirrorJob(c.sync_id)!.attempts, 8);
    const count = keys.length; f.bridge.sendToBoundFeishu(f.alice, f.input('c')); await f.bridge.pump(); assert.equal(keys.length, count);
  } finally { f.store.close(); }
});
test('expired leases and deduplication window stop without sending again', async () => {
  const f = mirrorFixture(); try {
    const unstarted = f.bridge.sendToBoundFeishu({ ...f.alice, expiresAt: f.now() + 10 }, f.input('unstarted')); f.advance(11); await f.bridge.pump(); assert.equal(f.store.mirrorJob(unstarted.sync_id)!.state, 'cancelled');
    const attempted = f.bridge.sendToBoundFeishu(f.alice, f.input('attempted')); let calls = 0;
    f.sender.sendBound = async () => { calls++; throw new Error('MOCK timeout'); }; await f.bridge.pump(); f.advance(55 * 60000); await f.bridge.pump();
    assert.equal(calls, 1); assert.equal(f.store.mirrorJob(attempted.sync_id)!.state, 'uncertain');
  } finally { f.store.close(); }
});
test('unlink during an in-flight send cannot retract it but prevents later queued sends', async () => {
  const f = mirrorFixture(); try {
    const a = f.bridge.sendToBoundFeishu(f.alice, f.input('a')), b = f.bridge.sendToBoundFeishu(f.alice, f.input('b'));
    let finish!: (id: string) => void; f.sender.sendBound = async () => new Promise(resolve => { finish = resolve; });
    const pumping = f.bridge.pump(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.store.mirrorJob(a.sync_id)!.state, 'sending'); f.bridge.unlink(f.alice); finish('om_MOCK_inflight'); await pumping;
    assert.equal(f.store.mirrorJob(a.sync_id)!.state, 'sent'); assert.equal(f.store.mirrorJob(b.sync_id)!.state, 'cancelled');
  } finally { f.store.close(); }
});
test('legacy or tampered queued credential payloads are blocked before outbound calls', async () => {
  const f = mirrorFixture(); try {
    const a = f.bridge.sendToBoundFeishu(f.alice, f.input()); f.store.db.prepare('UPDATE mirror_outbox SET payload=? WHERE id=?').run(JSON.stringify({ text: syntheticCredential }), a.sync_id);
    await f.bridge.pump(); assert.equal(f.store.mirrorJob(a.sync_id)!.state, 'blocked'); assert.equal(f.deliveries.length, 0);
    await f.subscribe(); f.bridge.receive(f.message()); const event = f.bridge.listPendingEvents(f.alice, {}).events[0]!;
    f.store.db.prepare('UPDATE inbox SET text=? WHERE id=?').run(syntheticCredential, event.event_id);
    assert.equal(f.bridge.getEvent(f.alice, { event_id: event.event_id }).text, OMITTED_CREDENTIAL_TEXT);
    f.store.db.prepare("UPDATE jobs SET payload=? WHERE kind='event'").run(JSON.stringify({ data: { text: syntheticCredential } }));
    await f.bridge.pump(); assert.equal(f.calls.filter(c => c.body.eventId).length, 0);
  } finally { f.store.close(); }
});
test('additive v1 migration retains original events and recovers mirror crashes with the same key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'MOCK-mirror-')); const path = join(dir, 'db.sqlite'); const f = mirrorFixture(path);
  try {
    f.bridge.receive(f.message()); const event = f.bridge.listPendingEvents(f.alice, {}).events[0]!;
    f.store.db.exec('DROP TABLE mirror_outbox; DROP TABLE content_dispositions; PRAGMA user_version=1'); f.store.close();
    const migrated = new Store(path); const bridge = new Bridge(migrated, new SecretBox(f.storageKey), f.transport, f.sender, f.now);
    assert.equal(migrated.db.prepare('PRAGMA user_version').get()!.user_version, 3); assert.equal(bridge.getEvent(f.alice, { event_id: event.event_id }).text, f.message().text);
    const job = bridge.sendToBoundFeishu(f.alice, f.input()); migrated.db.prepare("UPDATE mirror_outbox SET state='sending',attempts=1,firstAttemptAt=? WHERE id=?").run(f.now(), job.sync_id); migrated.close();
    const recovered = new Store(path); try { const restarted = new Bridge(recovered, new SecretBox(f.storageKey), f.transport, f.sender, f.now); await restarted.pump(); assert.equal(f.deliveries.length, 1); assert.equal(f.deliveries[0]!.key, hash(job.sync_id).slice(0, 32)); assert.equal(recovered.mirrorJob(job.sync_id)!.attempts, 2); } finally { recovered.close(); }
    const future = new DatabaseSync(path); future.exec('PRAGMA user_version=99'); future.close(); assert.throws(() => new Store(path), /Unsupported database schema/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('official sender uses message.create with server-resolved chat and stable UUID, returning remote ID', async () => {
  const sender = new LarkSender([mockApp]); let request: unknown;
  const fake = { im: { message: { create: async (args: unknown) => { request = args; return { code: 0, data: { message_id: 'om_MOCK' } }; } } } };
  (sender as unknown as { clients: Map<string, unknown> }).clients.set(mockApp.appId, fake);
  assert.equal(await sender.sendBound(mockApp.appId, 'oc_MOCK_bound', 'hello', 'MOCK_stable'), 'om_MOCK');
  assert.deepEqual(request, { params: { receive_id_type: 'chat_id' }, data: { receive_id: 'oc_MOCK_bound', content: '{"text":"hello"}', msg_type: 'text', uuid: 'MOCK_stable' } });
  await assert.rejects(sender.sendBound('cli_wrong', 'oc_MOCK_bound', 'hello', 'MOCK_stable'), /unknown_app/);
});
test('authenticated decoder preserves exact pairing commands for one-use consumption, never message forwarding', () => {
  const f = fixture(); try {
    const pair = f.bridge.beginBinding(f.alice); const raw = encryptedCallback(feishuPayload(pair.command));
    const decoded = decodeFeishu(mockApp, raw.raw, new Headers(raw.headers)); assert.ok('message' in decoded);
    if (!('message' in decoded)) throw new Error(); assert.equal(decoded.message.text, pair.command);
    assert.equal(f.bridge.receive(decoded.message).state, 'bound'); assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM inbox').get()!.n, 0);
    assert.equal(f.bridge.receive({ ...decoded.message, messageId: 'MOCK_replay' }).state, 'binding_rejected');
  } finally { f.store.close(); }
});
test('callback backlog cannot starve mirror sends and blocked reply reports its omission status', async () => {
  const f = mirrorFixture(); try {
    await f.subscribe(); for (let i = 0; i < 4; i++) f.bridge.receive(f.message({ messageId: 'backlog_' + i }));
    f.bridge.sendToBoundFeishu(f.alice, f.input()); await f.bridge.pump(2); assert.equal(f.deliveries.length, 1);
    const event = f.bridge.listPendingEvents(f.alice, {}).events[0]!;
    assert.equal(f.bridge.reply(f.alice, { event_id: event.event_id, text: syntheticCredential }).content_status, 'credential_blocked');
  } finally { f.store.close(); }
});
test('same source ID is isolated across owners, and personal startup refuses foreign mirror jobs before recovery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'MOCK-mirror-scope-')); const path = join(dir, 'db.sqlite'); const f = mirrorFixture(path);
  try {
    const other = f.bind(f.bob, { openId: 'ou_MOCK_bob', chatId: 'oc_MOCK_bob' });
    const a = f.bridge.sendToBoundFeishu(f.alice, f.input('same'));
    const b = f.bridge.sendToBoundFeishu(f.bob, { ...f.input('same'), binding_id: other.id }); assert.notEqual(a.sync_id, b.sync_id);
    assert.throws(() => f.bridge.mirrorDeliveryStatus(f.alice, { sync_id: b.sync_id }), /sync_not_found/);
    await f.bridge.pump(); assert.deepEqual(f.deliveries.map(x => x.chatId), [f.binding.chatId, other.chatId]);
    // Remove all second-owner ordinary state so only the malicious outbox identity remains.
    f.store.db.prepare('UPDATE mirror_outbox SET owner=?,state=? WHERE id=?').run('oauth:FOREIGN', 'sending', a.sync_id);
    f.store.db.prepare('DELETE FROM mirror_outbox WHERE id=?').run(b.sync_id); f.store.db.prepare('DELETE FROM bindings WHERE id=?').run(other.id); f.store.close();
    assert.throws(() => new Store(path, { owner: f.alice.id, appId: mockApp.appId, tenantKey: mockApp.tenantKey }), /Mirror outbox belongs/);
    const check = new DatabaseSync(path); try { assert.equal(check.prepare('SELECT state FROM mirror_outbox WHERE id=?').get(a.sync_id)!.state, 'sending'); } finally { check.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
