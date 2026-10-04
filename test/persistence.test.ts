import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture } from './fixtures.js';
import { Store } from '../src/store.js';
import { Bridge } from '../src/bridge.js';
import { SecretBox } from '../src/crypto.js';
test('SQLite persists identity, deduplication, subscription and queued jobs across restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-bridge-test-')); const path = join(dir, 'db.sqlite'); const f = fixture(path);
  try { f.bind(); await f.subscribe(); f.bridge.receive(f.message()); f.store.close();
    const restartedStore = new Store(path); try { const restarted = new Bridge(restartedStore, new SecretBox(f.storageKey), f.transport, f.sender, f.now); assert.equal(restarted.receive(f.message()).state, 'duplicate'); await restarted.pump(); assert.equal(f.calls.filter(c => c.body.eventId).length, 1); assert.ok(restartedStore.binding(f.alice.id)); const sub = restartedStore.db.prepare('SELECT secret FROM subscriptions').get()!; assert.notEqual(sub.secret, f.secret); } finally { restartedStore.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
