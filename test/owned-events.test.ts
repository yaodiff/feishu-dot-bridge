/** Synthetic-only inbox reads; no live installation, provider, or callback access. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../src/bridge.js';
import { BridgeError } from '../src/types.js';
import { hash, SecretBox } from '../src/crypto.js';
import { fixture, mockApp } from './fixtures.js';
import { personalFixture } from './personal-fixtures.js';

const eventId = (messageId: string, appId = mockApp.appId, tenant = mockApp.tenantKey) => `evt_${hash(JSON.stringify([appId, tenant, messageId]))}`;
function receive(f: ReturnType<typeof fixture>, n: number) {
  for (let i = 0; i < n; i++) f.bridge.receive(f.message({ messageId: `MOCK_${i}`, text: `MOCK text ${i}` }));
}
const errorCode = (code: string) => (error: unknown) => error instanceof BridgeError && error.code === code;

test('reads return only stable event ID, text, timestamp, and safe reply summary; never authorize or send', () => {
  const f = fixture(); try {
    f.bind(); receive(f, 1);
    const expected = { event_id: eventId('MOCK_0'), text: 'MOCK text 0', timestamp: f.message().timestamp };
    assert.deepEqual(f.bridge.listPendingEvents(f.alice), { events: [expected], next_cursor: null });
    assert.deepEqual(f.bridge.getEvent(f.alice, { event_id: expected.event_id }), { ...expected, reply: { state: 'not_queued', attempts: 0 } });
    assert.deepEqual(f.sent, []); assert.deepEqual(f.calls, []);
  } finally { f.store.close(); }
});

test('read authorization rejects expired and revoked principals before inspecting arguments or cursors', () => {
  for (const revoked of [false, true]) {
    const f = fixture(); try {
      f.bind(); receive(f, 2); const cursor = f.bridge.listPendingEvents(f.alice, { limit: 1 }).next_cursor;
      if (revoked) f.store.revoke(f.alice.id); else f.alice.expiresAt = f.now();
      for (const args of [{}, { cursor }, { limit: 'bad', cursor: 'bad' }]) assert.throws(() => f.bridge.listPendingEvents(f.alice, args), errorCode('unauthorized'));
      for (const args of [{ event_id: eventId('MOCK_0') }, { event_id: 'unknown' }, null]) assert.throws(() => f.bridge.getEvent(f.alice, args), errorCode('unauthorized'));
    } finally { f.store.close(); }
  }
});

test('cross-owner events and cursors reveal neither text nor cursor existence', () => {
  const f = fixture(); try {
    f.bind(); f.bind(f.bob, { openId: 'ou_bob', chatId: 'oc_bob' }); receive(f, 3);
    f.bridge.receive(f.message({ messageId: 'MOCK_bob', openId: 'ou_bob', chatId: 'oc_bob', text: 'BOB ONLY' }));
    const page = f.bridge.listPendingEvents(f.alice, { limit: 1 });
    assert.equal(f.bridge.listPendingEvents(f.bob).events[0]!.text, 'BOB ONLY');
    for (const cursor of [page.next_cursor, 'unknown', Buffer.from('unknown').toString('base64url')]) assert.throws(() => f.bridge.listPendingEvents(f.bob, { cursor }), errorCode('invalid_cursor'));
    for (const id of [eventId('MOCK_0'), 'unknown']) assert.throws(() => f.bridge.getEvent(f.bob, { event_id: id }), errorCode('event_not_found'));
    assert.equal(f.bridge.listPendingEvents({ id: 'unbound', expiresAt: f.alice.expiresAt }).events.length, 0);
    assert.throws(() => f.bridge.listPendingEvents({ id: 'unbound', expiresAt: f.alice.expiresAt }, { cursor: page.next_cursor }), errorCode('invalid_cursor'));
  } finally { f.store.close(); }
});

test('personal mode permits only the fixed owner and fixed app/tenant, including post-startup drift', () => {
  const f = personalFixture(); try {
    const pair = f.bridge.beginBinding(f.owner); f.bridge.receive(f.message({ text: pair.command, messageId: 'bind' }));
    f.bridge.receive(f.message({ messageId: 'personal' }));
    assert.equal(f.bridge.listPendingEvents(f.owner).events.length, 1);
    assert.throws(() => f.bridge.listPendingEvents(f.alice), errorCode('unauthorized'));
    assert.throws(() => f.bridge.getEvent(f.alice, { event_id: eventId('personal') }), errorCode('unauthorized'));
    for (const field of ['appId', 'tenantKey']) {
      const b = f.store.binding(f.owner.id)!; const old = field === 'appId' ? b.appId : b.tenantKey;
      f.store.db.prepare(`UPDATE bindings SET ${field}=? WHERE id=?`).run('MOCK_other', b.id);
      f.store.db.prepare(`UPDATE inbox SET ${field}=? WHERE bindingId=?`).run('MOCK_other', b.id);
      assert.deepEqual(f.bridge.listPendingEvents(f.owner), { events: [], next_cursor: null });
      assert.throws(() => f.bridge.getEvent(f.owner, { event_id: eventId('personal') }), errorCode('event_not_found'));
      f.store.db.prepare(`UPDATE bindings SET ${field}=? WHERE id=?`).run(old, b.id);
      f.store.db.prepare(`UPDATE inbox SET ${field}=? WHERE bindingId=?`).run(old, b.id);
    }
  } finally { f.store.close(); }
});

test('all owner/app/tenant/sender/chat inbox columns must match the current active binding', () => {
  const f = fixture(); try {
    const binding = f.bind(); receive(f, 1);
    for (const [field, original] of Object.entries({ owner: binding.owner, appId: binding.appId, tenantKey: binding.tenantKey, openId: binding.openId, chatId: binding.chatId })) {
      f.store.db.prepare(`UPDATE inbox SET ${field}=? WHERE id=?`).run('MOCK_wrong_scope', eventId('MOCK_0'));
      assert.deepEqual(f.bridge.listPendingEvents(f.alice), { events: [], next_cursor: null }, field);
      assert.throws(() => f.bridge.getEvent(f.alice, { event_id: eventId('MOCK_0') }), errorCode('event_not_found'), field);
      f.store.db.prepare(`UPDATE inbox SET ${field}=? WHERE id=?`).run(original, eventId('MOCK_0'));
    }
    f.store.db.prepare('UPDATE bindings SET active=0 WHERE id=?').run(binding.id);
    assert.deepEqual(f.bridge.listPendingEvents(f.alice), { events: [], next_cursor: null });
    assert.throws(() => f.bridge.getEvent(f.alice, { event_id: eventId('MOCK_0') }), errorCode('event_not_found'));
  } finally { f.store.close(); }
});

test('unlink and rebind cannot expose old events or reuse the previous binding cursor', () => {
  const f = fixture(); try {
    f.bind(); receive(f, 2); const cursor = f.bridge.listPendingEvents(f.alice, { limit: 1 }).next_cursor;
    f.bridge.unlink(f.alice);
    assert.throws(() => f.bridge.listPendingEvents(f.alice, { cursor }), errorCode('invalid_cursor'));
    f.bind(); f.bridge.receive(f.message({ messageId: 'MOCK_new_binding', text: 'NEW' }));
    assert.throws(() => f.bridge.listPendingEvents(f.alice, { cursor }), errorCode('invalid_cursor'));
    assert.throws(() => f.bridge.getEvent(f.alice, { event_id: eventId('MOCK_0') }), errorCode('event_not_found'));
    assert.deepEqual(f.bridge.listPendingEvents(f.alice).events.map(e => e.text), ['NEW']);
  } finally { f.store.close(); }
});

test('recent window is inclusive at exactly 24 hours and rejects malformed or future timestamps', () => {
  const f = fixture(); try {
    f.bind(); const since = f.now() - 24 * 3600000;
    for (const [id, timestamp] of [['boundary', new Date(since).toISOString()], ['old', new Date(since - 1).toISOString()], ['future', new Date(f.now() + 1).toISOString()], ['bad', 'not a date']]) f.bridge.receive(f.message({ messageId: id!, timestamp: timestamp! }));
    assert.deepEqual(f.bridge.listPendingEvents(f.alice).events.map(e => e.event_id), [eventId('boundary')]);
    assert.equal(f.bridge.getEvent(f.alice, { event_id: eventId('boundary') }).reply.state, 'not_queued');
    for (const id of ['old', 'future', 'bad', 'unknown']) assert.throws(() => f.bridge.getEvent(f.alice, { event_id: eventId(id) }), errorCode('event_not_found'));
    f.advance(1); assert.throws(() => f.bridge.getEvent(f.alice, { event_id: eventId('boundary') }), errorCode('event_not_found'));
  } finally { f.store.close(); }
});

test('pagination defaults to 10, allows up to 20, is ordered and excludes new arrivals until a fresh list', () => {
  const f = fixture(); try {
    f.bind(); receive(f, 25);
    assert.equal(f.bridge.listPendingEvents(f.alice).events.length, 10);
    assert.equal(f.bridge.listPendingEvents(f.alice, { limit: 20 }).events.length, 20);
    const one = f.bridge.listPendingEvents(f.alice, { limit: 7 }); assert.equal(one.events.length, 7);
    f.bridge.receive(f.message({ messageId: 'late', text: 'LATE' }));
    const two = f.bridge.listPendingEvents(f.alice, { limit: 20, cursor: one.next_cursor });
    assert.equal(two.events.length, 18); assert.equal(two.next_cursor, null);
    assert.deepEqual([...one.events, ...two.events].map(e => e.event_id), Array.from({ length: 25 }, (_, i) => eventId(`MOCK_${i}`)));
    const fresh = f.bridge.listPendingEvents(f.alice, { limit: 20 });
    assert.equal(f.bridge.listPendingEvents(f.alice, { cursor: fresh.next_cursor }).events.at(-1)!.text, 'LATE');
    assert.deepEqual(f.bridge.listPendingEvents(f.alice, { limit: 20, cursor: one.next_cursor }), two);
    const restarted = new Bridge(f.store, new SecretBox(f.storageKey), f.transport, f.sender, f.now);
    assert.deepEqual(restarted.listPendingEvents(f.alice, { limit: 20, cursor: one.next_cursor }), two);
  } finally { f.store.close(); }
});

test('pages recheck rolling age and newly reserved replies without marking reads or consuming cursors', () => {
  const f = fixture(); try {
    f.bind(); const old = new Date(f.now() - 24 * 3600000 + 1000).toISOString();
    for (const id of ['first', 'will_expire', 'will_reply', 'last']) f.bridge.receive(f.message({ messageId: id, timestamp: id === 'will_expire' ? old : f.message().timestamp }));
    const first = f.bridge.listPendingEvents(f.alice, { limit: 1 });
    f.bridge.reply(f.alice, { event_id: eventId('will_reply'), text: 'already reserved' }); f.advance(1001);
    const next = f.bridge.listPendingEvents(f.alice, { cursor: first.next_cursor });
    assert.deepEqual(next.events.map(e => e.event_id), [eventId('last')]); assert.equal(next.next_cursor, null);
    assert.equal(f.bridge.listPendingEvents(f.alice).events[0]!.event_id, eventId('first'));
  } finally { f.store.close(); }
});

test('cursor expires after 15 minutes or the issuing principal lease, whichever comes first', () => {
  for (const short of [false, true]) {
    const f = fixture(); try {
      f.bind(); receive(f, 2); if (short) f.alice.expiresAt = f.now() + 500;
      const cursor = f.bridge.listPendingEvents(f.alice, { limit: 1 }).next_cursor;
      f.advance(short ? 500 : 15 * 60000); f.alice.expiresAt = f.now() + 3600000;
      assert.throws(() => f.bridge.listPendingEvents(f.alice, { cursor }), errorCode('invalid_cursor'));
      assert.equal(f.bridge.listPendingEvents(f.alice).events.length, 2);
    } finally { f.store.close(); }
  }
});

test('cursor is opaque, tamper-proof, typed, structurally bounded, and bound to the full current identity', () => {
  const f = fixture(); try {
    const binding = f.bind(); receive(f, 3); const cursor = f.bridge.listPendingEvents(f.alice, { limit: 1 }).next_cursor!;
    assert.ok(cursor.length <= 1024); assert.ok(!Buffer.from(cursor, 'base64url').toString().includes(f.alice.id));
    const box = new SecretBox(f.storageKey), decoded = JSON.parse(box.open(Buffer.from(cursor, 'base64url').toString('base64')));
    for (const change of [{ type: 'different-purpose' }, { scope: hash('another-owner') }, { after: -1 }, { after: 10, through: 2 }, { after: 1.5 }, { through: Number.MAX_SAFE_INTEGER + 1 }, { at: f.now() + 1 }, { expires: f.now() }, { expires: f.now() + 15 * 60000 + 1 }, { extra: 'unexpected' }]) {
      const bad = Buffer.from(box.seal(JSON.stringify({ ...decoded, ...change })), 'base64').toString('base64url');
      assert.throws(() => f.bridge.listPendingEvents(f.alice, { cursor: bad }), errorCode('invalid_cursor'));
    }
    const corrupted = Buffer.from(cursor, 'base64url'); corrupted[15] = corrupted[15]! ^ 1;
    for (const bad of [corrupted.toString('base64url'), cursor + '=', '!', 'A', Buffer.alloc(16).toString('base64url')]) assert.throws(() => f.bridge.listPendingEvents(f.alice, { cursor: bad }), errorCode('invalid_cursor'));
    f.store.db.prepare('UPDATE bindings SET chatId=? WHERE id=?').run('oc_different', binding.id);
    assert.throws(() => f.bridge.listPendingEvents(f.alice, { cursor }), errorCode('invalid_cursor'));
  } finally { f.store.close(); }
});

test('invalid limits, oversized cursors, and caller-supplied identity or recipient arguments are rejected', () => {
  const f = fixture(); try {
    f.bind(); receive(f, 1);
    for (const limit of [0, -1, 21, 1.5, '10', null, Infinity, NaN]) assert.throws(() => f.bridge.listPendingEvents(f.alice, { limit }));
    for (const args of [{ cursor: '' }, { cursor: 'a'.repeat(1025) }, { cursor: null }, { owner: f.bob.id }, { event_id: eventId('MOCK_0') }, null, []]) assert.throws(() => f.bridge.listPendingEvents(f.alice, args));
    for (const args of [{}, { event_id: '' }, { event_id: 'a'.repeat(257) }, { event_id: eventId('MOCK_0'), owner: f.bob.id }, { event_id: eventId('MOCK_0'), chat_id: 'oc_other' }, { event_id: 42 }, null]) assert.throws(() => f.bridge.getEvent(f.alice, args));
  } finally { f.store.close(); }
});

test('every existing reply job excludes an event regardless of state; event delivery jobs do not', async () => {
  const f = fixture(); try {
    f.bind(); await f.subscribe(); receive(f, 8);
    assert.equal(f.bridge.listPendingEvents(f.alice).events.length, 8);
    for (const [i, state] of ['pending', 'sending', 'sent', 'dead', 'cancelled', 'uncertain', 'PRIVATE_UNKNOWN_STATE'].entries()) {
      f.bridge.reply(f.alice, { event_id: eventId(`MOCK_${i}`), text: 'PRIVATE_REPLY_BODY' });
      f.store.db.prepare('UPDATE jobs SET state=?, attempts=? WHERE kind=? AND inboxId=?').run(state, i, 'reply', eventId(`MOCK_${i}`));
      assert.deepEqual(f.bridge.getEvent(f.alice, { event_id: eventId(`MOCK_${i}`) }).reply, { state: i === 6 ? 'unknown' : state, attempts: i });
    }
    assert.deepEqual(f.bridge.listPendingEvents(f.alice).events.map(e => e.event_id), [eventId('MOCK_7')]);
    assert.ok(!JSON.stringify(f.bridge.getEvent(f.alice, { event_id: eventId('MOCK_6') })).includes('PRIVATE_'));
  } finally { f.store.close(); }
});

test('reads execute with SQLite query_only and do not mutate DB, jobs, callback delivery, or reply attempts', async () => {
  const f = fixture(); try {
    f.bind(); await f.subscribe(); receive(f, 3);
    f.bridge.reply(f.alice, { event_id: eventId('MOCK_2'), text: 'reserved' });
    const tables = ['bindings', 'pairs', 'subscriptions', 'inbox', 'receipts', 'jobs', 'revoked'];
    const snapshot = () => JSON.stringify(tables.map(table => f.store.db.prepare(`SELECT * FROM ${table}`).all()));
    const before = snapshot(), calls = f.calls.length, changes = f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
    f.store.db.exec('PRAGMA query_only=ON');
    const page = f.bridge.listPendingEvents(f.alice, { limit: 1 }); f.bridge.listPendingEvents(f.alice, { cursor: page.next_cursor });
    f.bridge.getEvent(f.alice, { event_id: eventId('MOCK_2') }); f.bridge.getEvent(f.alice, { event_id: eventId('MOCK_0') });
    assert.equal(snapshot(), before); assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n, changes);
    assert.equal(f.calls.length, calls); assert.equal(f.sent.length, 0);
  } finally { f.store.close(); }
});

test('continuing under a shorter renewed lease shortens descendants, and storage-key rotation rejects old cursors', () => {
  const f = fixture(); try {
    f.bind(); receive(f, 4);
    const original = f.bridge.listPendingEvents(f.alice, { limit: 1 }).next_cursor;
    const shorter = { ...f.alice, expiresAt: f.now() + 1000 };
    const derived = f.bridge.listPendingEvents(shorter, { cursor: original, limit: 1 }).next_cursor;
    assert.ok(derived); f.advance(1000);
    assert.throws(() => f.bridge.listPendingEvents(f.alice, { cursor: derived }), errorCode('invalid_cursor'));
    assert.equal(f.bridge.listPendingEvents(f.alice, { cursor: original }).events.length, 3);
    const rotated = new Bridge(f.store, new SecretBox(Buffer.alloc(32, 2)), f.transport, f.sender, f.now);
    assert.throws(() => rotated.listPendingEvents(f.alice, { cursor: original }), errorCode('invalid_cursor'));
    assert.equal(rotated.listPendingEvents(f.alice).events.length, 4);
  } finally { f.store.close(); }
});
