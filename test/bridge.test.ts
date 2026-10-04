import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fixture, verifyDelivery } from './fixtures.js';
import { hash } from '../src/crypto.js';
test('MOCK end-to-end: bind two accounts, subscribe, route and reply to each owner only', async () => {
  const f = fixture(); try {
    const a = f.bind(), b = f.bind(f.bob, { tenantKey: 'tenant_other', openId: 'ou_alice', chatId: 'oc_bob' });
    await f.subscribe(); await f.subscribe(f.bob);
    assert.notEqual(a.id, b.id);
    f.bridge.receive(f.message()); f.bridge.receive(f.message({ tenantKey: 'tenant_other', chatId: 'oc_bob', messageId: 'om_bob' }));
    await f.bridge.pump(); const events = f.calls.filter(c => c.body.eventId);
    assert.equal(events.length, 2); assert.match(events[0]!.url, /alice/); assert.match(events[1]!.url, /bob/);
    for (const e of events) verifyDelivery(f.secret, e);
    assert.throws(() => f.bridge.reply(f.bob, { event_id: events[0]!.body.eventId, text: 'hijack' }), /event_not_found/);
    assert.throws(() => f.bridge.reply(f.alice, { event_id: events[0]!.body.eventId, text: 'x', chat_id: 'oc_victim' }));
    f.bridge.reply(f.alice, { event_id: events[0]!.body.eventId, text: '你好 Alice' });
    f.bridge.reply(f.bob, { event_id: events[1]!.body.eventId, text: '你好 Bob' });
    await f.bridge.pump(); assert.deepEqual(f.sent.map(s => s.messageId), ['om_message', 'om_bob']);
  } finally { f.store.close(); }
});
test('pair codes are one-use, expire, never stored plaintext or forwarded, cannot steal identity', () => {
  const f = fixture(); try {
    const pair = f.bridge.beginBinding(f.alice); assert.equal(f.bridge.receive(f.message({ text: pair.command })).state, 'bound');
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM inbox').get()!.n, 0);
    assert.equal(f.bridge.receive(f.message({ messageId: 'replay', openId: 'attacker', text: pair.command })).state, 'binding_rejected');
    const stolen = f.bridge.beginBinding(f.bob); assert.equal(f.bridge.receive(f.message({ messageId: 'steal', text: stolen.command })).state, 'binding_rejected');
    assert.equal(f.store.binding(f.bob.id), undefined);
    f.advance(300001); assert.equal(f.bridge.receive(f.message({ messageId: 'late', openId: 'ou_bob', text: stolen.command })).state, 'binding_rejected');
    assert.throws(() => f.bridge.beginBinding(f.alice), /already_bound/);
  } finally { f.store.close(); }
});
test('message_id dedupe is persistent, namespaced by tenant and app, and duplicate replies are idempotent', async () => {
  const f = fixture(); try {
    f.bind(); await f.subscribe(); assert.equal(f.bridge.receive(f.message()).state, 'accepted'); assert.equal(f.bridge.receive(f.message()).state, 'duplicate');
    await f.bridge.pump(); const eventId = f.calls.find(c => c.body.eventId)!.body.eventId;
    const first = f.bridge.reply(f.alice, { event_id: eventId, text: 'reply' }); f.bridge.reply(f.alice, { event_id: eventId, text: 'reply' });
    assert.throws(() => f.bridge.reply(f.alice, { event_id: eventId, text: 'different' }), /reply_already_reserved/);
    await Promise.all([f.bridge.pump(), f.bridge.pump()]); assert.equal(f.sent.length, 1); assert.equal(f.store.job(first.reply_id)!.state, 'sent');
  } finally { f.store.close(); }
});
test('subscription ownership, TTL, deterministic identity, challenge and secret checks', async () => {
  const f = fixture(); try {
    const b = f.bind(); const input = { name: 'feishu.message.created', arguments: { binding_id: b.id }, delivery: { mode: 'webhook', url: 'https://callback.example/dot/a', secret: f.secret } };
    await assert.rejects(f.bridge.subscribe(f.bob, input), /binding_not_found/);
    await assert.rejects(f.bridge.subscribe(f.alice, { ...input, owner_id: f.bob.id }));
    await assert.rejects(f.bridge.subscribe(f.alice, { ...input, delivery: { ...input.delivery, secret: 'whsec_bad' } }), /invalid_signing_secret/);
    const a = await f.bridge.subscribe(f.alice, input), same = await f.bridge.subscribe(f.alice, input); assert.equal(a.id, same.id); assert.ok(Date.parse(a.refreshBefore) <= f.alice.expiresAt);
    await assert.rejects(f.bridge.subscribe(f.alice, { ...input, delivery: { ...input.delivery, url: 'https://callback.example/second-dot' } }), /subscription_exists/);
    f.transport.post = async () => ({ status: 200, body: '{"challenge":"wrong"}' }); await assert.rejects(f.bridge.subscribe(f.alice, input), /verification_failed/);
    f.advance(3600001); await f.bridge.pump(); assert.throws(() => f.bridge.status(f.alice), /unauthorized/);
  } finally { f.store.close(); }
});
test('unchanged refresh cannot extend secret rotation grace', async () => {
  const f = fixture(); try {
    const b = f.bind(); await f.subscribe(); const input = { name: 'feishu.message.created', arguments: { binding_id: b.id }, delivery: { mode: 'webhook', url: 'https://callback.example/dot/oauth:alice', secret: `whsec_${randomBytes(32).toString('base64')}` } };
    const result = await f.bridge.subscribe(f.alice, input); const until = f.store.subscription(result.id)!.rotateUntil;
    f.advance(1000); await f.bridge.subscribe(f.alice, input); assert.equal(f.store.subscription(result.id)!.rotateUntil, until);
    f.advance(300001); await f.bridge.subscribe(f.alice, input); assert.equal(f.store.subscription(result.id)!.oldSecret, null);
  } finally { f.store.close(); }
});
test('unlink revokes pending event and reply jobs, rebind does not expose old messages', async () => {
  const f = fixture(); try {
    f.bind(); await f.subscribe(); f.bridge.receive(f.message()); const inbox = f.store.db.prepare('SELECT id FROM inbox').get()!;
    f.bridge.reply(f.alice, { event_id: inbox.id, text: 'reply' }); f.bridge.unlink(f.alice); await f.bridge.pump(); assert.equal(f.sent.length, 0); assert.equal(f.calls.filter(c => c.body.eventId).length, 0);
    f.bind(); assert.throws(() => f.bridge.reply(f.alice, { event_id: inbox.id, text: 'reply' }), /event_not_found/);
  } finally { f.store.close(); }
});
test('retry ordering preserves lane order and stable event IDs; 410 stops subscription', async () => {
  const f = fixture(); try {
    f.bind(); await f.subscribe(); const calls: string[] = []; let status = 503;
    f.transport.post = async (_url, raw) => { calls.push(JSON.parse(raw).eventId); return { status, body: '{}' }; };
    f.bridge.receive(f.message()); f.bridge.receive(f.message({ messageId: 'second' }));
    await f.bridge.pump(); assert.equal(calls.length, 1); await f.bridge.pump(); assert.equal(calls.length, 1);
    f.advance(1001); status = 200; await f.bridge.pump(); assert.equal(calls.length, 3); assert.equal(calls[0], calls[1]); assert.notEqual(calls[1], calls[2]);
    f.bridge.receive(f.message({ messageId: 'third' })); status = 410; await f.bridge.pump(); assert.equal(f.store.db.prepare('SELECT active FROM subscriptions').get()!.active, 0);
  } finally { f.store.close(); }
});
test('revoked principals cannot bind, subscribe or deliver', async () => {
  const f = fixture(); try { f.bind(); await f.subscribe(); f.bridge.receive(f.message()); f.store.revoke(f.alice.id); assert.throws(() => f.bridge.beginBinding(f.alice), /unauthorized/); await f.bridge.pump(); assert.equal(f.calls.filter(c => c.body.eventId).length, 0); } finally { f.store.close(); }
});
test('pending retries after Feishu dedupe window become uncertain, never blindly resent', async () => {
  const f = fixture(); try { f.bind(); await f.subscribe(); f.bridge.receive(f.message()); const eventId = f.store.db.prepare('SELECT id FROM inbox').get()!.id as string; f.bridge.reply(f.alice, { event_id: eventId, text: 'hello' }); f.sender.reply = async () => { throw new Error('timeout'); }; await f.bridge.pump(); f.advance(55 * 60000); f.sender.reply = async () => { throw new Error('must not execute'); }; await f.bridge.pump(); assert.equal(f.store.job(`reply_${hash(eventId)}`)!.state, 'uncertain'); } finally { f.store.close(); }
});
test('eight ambiguous reply timeouts end uncertain, and status is owner-scoped', async () => {
  const f = fixture(); try {
    f.bind(); f.bridge.receive(f.message()); const eventId = f.store.db.prepare('SELECT id FROM inbox').get()!.id as string;
    assert.equal(f.bridge.deliveryStatus(f.alice, eventId).state, 'not_queued');
    f.bridge.reply(f.alice, { event_id: eventId, text: 'hello' });
    f.sender.reply = async () => { throw new Error('remote accepted but response was lost'); };
    for (let i = 0; i < 8; i++) { await f.bridge.pump(); f.advance(1000 * 2 ** i + 1); }
    assert.equal(f.bridge.deliveryStatus(f.alice, eventId).state, 'uncertain');
    assert.equal(f.bridge.deliveryStatus(f.alice, eventId).attempts, 8);
    assert.throws(() => f.bridge.deliveryStatus(f.bob, eventId), /event_not_found/);
  } finally { f.store.close(); }
});
test('unsubscribe cancels queued events even if the same deterministic subscription is later renewed', async () => {
  const f = fixture(); try {
    const b = f.bind(); await f.subscribe(); f.bridge.receive(f.message());
    f.bridge.unsubscribe(f.alice, { name: 'feishu.message.created', arguments: { binding_id: b.id }, delivery: { mode: 'webhook', url: 'https://callback.example/dot/oauth:alice' } });
    await f.subscribe(); await f.bridge.pump(); assert.equal(f.calls.filter(c => c.body.eventId).length, 0);
  } finally { f.store.close(); }
});
