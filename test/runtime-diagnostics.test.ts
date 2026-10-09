import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeRuntimeDiagnostic } from '../src/runtime-diagnostics.js';
import { Bridge, type CallbackVerificationDiagnostic } from '../src/bridge.js';
import { SecretBox } from '../src/crypto.js';
import { fixture } from './fixtures.js';

test('diagnostics drop arbitrary fields and reject unknown values', () => {
  const base = { event: 'callback_transport', stage: 'response', outcome: 'succeeded', reason: 'none', elapsedMs: 120, httpStatus: 200, hostname: 'connectors.api.openai.com' };
  assert.deepEqual(sanitizeRuntimeDiagnostic({ ...base, secret: 'MOCK_SECRET', body: 'MOCK_BODY', headers: { authorization: 'MOCK_TOKEN' }, url: 'https://connectors.api.openai.com/MOCK_CAPABILITY' }), base);
  for (const key of ['event', 'stage', 'outcome', 'reason', 'hostname']) assert.equal(sanitizeRuntimeDiagnostic({ ...base, [key]: 'MOCK_SECRET' }), null);
  for (const elapsedMs of [-1, 60001, Infinity, NaN, 0.5, 'MOCK_SECRET']) assert.equal(sanitizeRuntimeDiagnostic({ ...base, elapsedMs }), null);
  assert.equal(sanitizeRuntimeDiagnostic({ ...base, httpStatus: 999 }), null);
});

test('startup diagnostics allow only fixed lifecycle states and reason codes', () => {
  for (const reason of ['ws_start_timeout', 'ws_start_failed', 'duplicate_ws_consumer', 'invalid_ws_configuration', 'ws_ingress_stopped', 'other']) {
    const safe = { event: 'bridge_start_failure', reason };
    assert.deepEqual(sanitizeRuntimeDiagnostic({ ...safe, error: 'MOCK_SECRET', url: 'MOCK_PRIVATE_URL' }), safe);
  }
  for (const state of ['ws_connecting', 'ws_ready', 'ws_reconnecting', 'ws_reconnected', 'ws_failed']) {
    const safe = { event: 'bridge_ws_lifecycle', state };
    assert.deepEqual(sanitizeRuntimeDiagnostic({ ...safe, message: 'MOCK_PRIVATE_MESSAGE' }), safe);
  }
  assert.equal(sanitizeRuntimeDiagnostic({ event: 'bridge_start_failure', reason: 'MOCK_SECRET' }), null);
  assert.equal(sanitizeRuntimeDiagnostic({ event: 'bridge_ws_lifecycle', state: 'MOCK_SECRET' }), null);
});

test('verification diagnostics identify each failure without exposing challenge material', async () => {
  for (const reason of ['request_failed', 'over_budget', 'http_status', 'invalid_json', 'challenge_missing', 'challenge_mismatch', 'verified'] as const) {
    const f = fixture();
    try {
      const binding = f.bind(), events: CallbackVerificationDiagnostic[] = [];
      f.transport.post = async (_url, body) => {
        if (reason === 'request_failed') throw new Error('MOCK_SECRET_ERROR');
        if (reason === 'over_budget') f.advance(10001);
        return { status: reason === 'http_status' ? 503 : 200, body: reason === 'invalid_json' ? 'MOCK_SECRET_INVALID_JSON' : reason === 'challenge_missing' ? '{}' : JSON.stringify({ challenge: reason === 'challenge_mismatch' ? 'MOCK_SECRET_WRONG_CHALLENGE' : JSON.parse(body).challenge }) };
      };
      const bridge = new Bridge(f.store, new SecretBox(f.storageKey), f.transport, f.sender, f.now, undefined, event => { events.push(event); });
      const input = { name: 'feishu.message.created', arguments: { binding_id: binding.id }, delivery: { mode: 'webhook', url: 'https://callback.example/MOCK_CAPABILITY', secret: f.secret } };
      if (reason === 'verified') await bridge.subscribe(f.alice, input);
      else await assert.rejects(bridge.subscribe(f.alice, input), /callback_verification_failed/);
      assert.equal(events.length, 1); assert.equal(events[0]!.reason, reason);
      assert.ok(sanitizeRuntimeDiagnostic(events[0]));
      assert.doesNotMatch(JSON.stringify(events), /MOCK_|whsec_|challenge":|signature|headers|delivery|https:\/\//);
    } finally { f.store.close(); }
  }
});

test('diagnostic hook errors do not alter successful subscription', async () => {
  for (const hook of [() => { throw new Error('synthetic observer failure'); }, async () => { throw new Error('synthetic asynchronous observer failure'); }]) {
    const f = fixture();
    try {
      const binding = f.bind();
      const bridge = new Bridge(f.store, new SecretBox(f.storageKey), f.transport, f.sender, f.now, undefined, hook);
      const result = await bridge.subscribe(f.alice, { name: 'feishu.message.created', arguments: { binding_id: binding.id }, delivery: { mode: 'webhook', url: 'https://callback.example/test', secret: f.secret } });
      await new Promise(resolve => setImmediate(resolve));
      assert.ok(result.id);
    } finally { f.store.close(); }
  }
});
