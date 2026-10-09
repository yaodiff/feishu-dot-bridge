/** Synthetic only: no real attachments, identities, configuration, or API calls. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ClientRequest } from 'node:http';
import type { request } from 'node:https';
import { fixture, feishuPayload, encryptedCallback, mockApp } from './fixtures.js';
import { BridgeError } from '../src/types.js';
import { hash } from '../src/crypto.js';
import { decodeFeishu, decodeFeishuWebSocket } from '../src/feishu.js';
import { MEDIA_LIMITS, parseMediaReference, resourcePath, inspectMedia, mediaByteLimit, type MediaKind, type MediaReference } from '../src/media-policy.js';
import { FeishuMediaTransport, collectResourceResponse, type MediaTransport } from '../src/feishu-media-transport.js';
import { MediaInputCandidate } from '../src/media-input.js';
const code = (expected: string) => (error: unknown) => error instanceof BridgeError && error.code === expected;
const png = () => Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const image: MediaReference = { kind: 'image', resourceType: 'image', resourceKey: 'img_MOCK' };
const eventId = (id = 'om_media') => `evt_${hash(JSON.stringify([mockApp.appId, mockApp.tenantKey, id]))}`;
function response(chunks: Buffer[], headers: Record<string, string> = { 'content-type': 'image/png' }, statusCode = 200, complete = true): IncomingMessage {
  return Object.assign(Readable.from(chunks), { headers, statusCode, complete }) as unknown as IncomingMessage;
}
function setup(approved = true, transport?: MediaTransport) {
  const f = fixture(); f.bind(); let downloads = 0;
  const media = new MediaInputCandidate(f.bridge, transport ?? { async download(input, signal, check) { downloads++; check(); return { bytes: png(), declaredMime: 'application/octet-stream' }; } }, () => approved, f.now);
  const receive = (ref = image, id = 'om_media') => media.receiveAuthenticated(f.message({ messageId: id, text: '[未同步：暂不支持此消息类型]', contentStatus: 'unsupported', mediaCandidate: ref }));
  return { ...f, media, receive, downloads: () => downloads, close: () => { media.close(); f.store.close(); } };
}
const state = (result: Awaited<ReturnType<MediaInputCandidate['read']>>) => JSON.parse((result.content[0] as { text: string }).text);

test('strict image references reject paths/URLs/extra keys and unsupported media', () => {
  assert.deepEqual(parseMediaReference('image', '{"image_key":"img_MOCK"}'), { supported: true, reference: image });
  for (const raw of ['{}', '{"image_key":"https://evil.invalid/x"}', '{"image_key":"img_../a"}', '{"image_key":"img_MOCK","url":"x"}', 'null', '[]', 'bad']) assert.equal(parseMediaReference('image', raw).supported, false);
  for (const type of ['audio', 'post', 'file', 'sticker', 'media', 'video', 'text']) assert.deepEqual(parseMediaReference(type, '{}'), { supported: false, reason: 'unsupported_media' });
  for (const raw of ['{"file_key":"file_MOCK","duration":1000}', '{"file_key":"file_MOCK","duration":60001}', 'bad', 'x'.repeat(5000)])
    assert.deepEqual(parseMediaReference('audio', raw), { supported: false, reason: 'unsupported_media' });
});
test('resource route binds exact message and resource type; rejects caller URLs', () => {
  assert.equal(resourcePath('om_MOCK', image), '/open-apis/im/v1/messages/om_MOCK/resources/img_MOCK?type=image');
  assert.throws(() => resourcePath('om_MOCK', { kind: 'audio', resourceType: 'file', resourceKey: 'file_MOCK' } as unknown as MediaReference), code('invalid_media_reference'));
  assert.throws(() => mediaByteLimit('audio' as MediaKind), code('unsupported_media'));
  for (const id of ['../secret', 'https://evil.invalid', 'om_a?evil', 'om_a%2fb', 'om_a/next']) assert.throws(() => resourcePath(id, image), code('invalid_media_reference'));
  assert.throws(() => resourcePath('om_MOCK', { ...image, resourceType: 'file' } as unknown as MediaReference), code('invalid_media_reference'));
});
test('authenticated decoder only captures references on explicit opt-in; tampered callback rejected first', () => {
  const payload = feishuPayload('', { type: 'image', messageId: 'om_media' }); payload.event.message.content = '{"image_key":"img_MOCK"}';
  const cb = encryptedCallback(payload); const old = decodeFeishu(mockApp, cb.raw, new Headers(cb.headers));
  assert.equal('message' in old && old.message.mediaCandidate, undefined);
  const candidate = decodeFeishu(mockApp, cb.raw, new Headers(cb.headers), Date.now(), true);
  assert.deepEqual('message' in candidate && candidate.message.mediaCandidate, image);
  assert.throws(() => decodeFeishu(mockApp, cb.raw + 'x', new Headers(cb.headers), Date.now(), true), code('invalid_feishu_signature'));
});
test('image validation enforces dimensions/MIME/size/container', () => {
  assert.deepEqual(inspectMedia(png(), 'image', 'image/png'), { mimeType: 'image/png', width: 1, height: 1 });
  assert.equal(inspectMedia(png(), 'image', 'application/octet-stream').mimeType, 'image/png');
  assert.throws(() => inspectMedia(png(), 'image', 'text/html'), code('media_mime_mismatch'));
  assert.throws(() => inspectMedia(Buffer.from('<svg/>'), 'image', 'image/svg+xml'), code('unsupported_image_format'));
  assert.throws(() => inspectMedia(Buffer.alloc(MEDIA_LIMITS.imageBytes + 1), 'image', 'image/png'), code('media_size_exceeded'));
  const huge = png(); huge.writeUInt32BE(100000, 16); assert.throws(() => inspectMedia(huge, 'image', 'image/png'), code('image_dimensions_exceeded'));
  assert.throws(() => inspectMedia(png().subarray(0, 40), 'image', 'image/png'), code('unsupported_image_format'));
});
test('stream collector rejects redirects/errors/compression/oversize/truncation with safe codes', async () => {
  assert.deepEqual((await collectResourceResponse(response([png()]), 1024)).bytes, png());
  for (const [res, expected] of [
    [response([png()], { 'content-type': 'image/png', 'content-length': '9999' }), 'media_size_exceeded'],
    [response([png()], { 'content-type': 'image/png', 'content-length': '1' }), 'media_truncated'],
    [response([png()], { 'content-type': 'image/png', 'content-encoding': 'gzip' }), 'media_encoding_rejected'],
    [response([png()], { 'content-type': 'image/png' }, 302), 'media_download_failed'],
    [response([png()], { 'content-type': 'image/png' }, 403), 'media_permission_denied'],
    [response([png()], {}, 200), 'media_mime_missing'],
    [response([png()], { 'content-type': 'image/png' }, 200, false), 'media_truncated'],
    [response([Buffer.alloc(1025)]), 'media_size_exceeded']
  ] as const) await assert.rejects(collectResourceResponse(res, 1024), code(expected));
});
test('owner event-only read returns MCP image content with provenance, never key/routing data', async () => {
  const f = setup(); try {
    f.receive(); const result = await f.media.read(f.alice, { event_id: eventId() });
    assert.equal(state(result).state, 'image_ready'); assert.equal(state(result).source, 'feishu'); assert.equal(result.content[1]!.type, 'image');
    assert.equal(inspectMedia(Buffer.from((result.content[1] as { data: string }).data, 'base64'), 'image', 'image/png').width, 1); assert.equal(state(result).image_sanitized, true);
    assert.equal(JSON.stringify(result).includes('img_MOCK'), false); assert.equal(f.downloads(), 1); assert.equal(f.sent.length, 0);
    await assert.rejects(f.media.read(f.alice, { event_id: eventId(), url: 'https://evil.invalid' }));
  } finally { f.close(); }
});
test('processing policy defaults deny before download', async () => {
  const f = setup(false); try { f.receive(); await assert.rejects(f.media.read(f.alice, { event_id: eventId() }), code('media_processing_not_authorized')); assert.equal(f.downloads(), 0); } finally { f.close(); }
});
test('unbound sender cannot register a capability', async () => {
  const f = setup(); try {
    assert.equal(f.media.receiveAuthenticated(f.message({ messageId: 'om_other', openId: 'ou_intruder', mediaCandidate: image })).state, 'unbound');
    await assert.rejects(f.media.read(f.alice, { event_id: eventId('om_other') }), code('event_not_found')); assert.equal(f.downloads(), 0);
  } finally { f.close(); }
});
test('cross-owner/revoked/expired/unlinked/rebound references fail before network', async () => {
  for (const variant of ['cross-owner', 'revoked', 'lease', 'ttl', 'rebind']) {
    const f = setup(); try {
      f.receive(); let user = f.alice;
      if (variant === 'cross-owner') { f.bind(f.bob, { openId: 'ou_bob', chatId: 'oc_bob' }); user = f.bob; }
      if (variant === 'revoked') f.store.revoke(f.alice.id);
      if (variant === 'lease') f.alice.expiresAt = f.now();
      if (variant === 'ttl') f.advance(MEDIA_LIMITS.referenceTtlMs);
      if (variant === 'rebind') { f.bridge.unlink(f.alice); f.bind(); }
      await assert.rejects(f.media.read(user, { event_id: eventId() })); assert.equal(f.downloads(), 0);
    } finally { f.close(); }
  }
});
test('all persisted identity columns remain tied to original capability', async () => {
  for (const column of ['owner', 'appId', 'tenantKey', 'openId', 'chatId', 'messageId']) {
    const f = setup(); try { f.receive(); f.store.db.prepare(`UPDATE inbox SET ${column}=? WHERE id=?`).run('MOCK_drift', eventId()); await assert.rejects(f.media.read(f.alice, { event_id: eventId() })); assert.equal(f.downloads(), 0); } finally { f.close(); }
  }
});
test('duplicate cannot replace key/reset TTL; retains schema 2 without blob persistence', async () => {
  const f = setup(); try {
    f.receive(); f.advance(1000); assert.equal(f.receive({ ...image, resourceKey: 'img_different' }).state, 'duplicate');
    assert.equal(f.store.db.prepare('PRAGMA user_version').get()!.user_version, 2);
    assert.equal(f.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().some(x => String(x.name).includes('media')), false);
    f.advance(MEDIA_LIMITS.referenceTtlMs - 1000); await assert.rejects(f.media.read(f.alice, { event_id: eventId() }), code('media_not_available'));
  } finally { f.close(); }
});
test('authenticated audio is a fixed unsupported notice with no reference, expiry, or download', async () => {
  const f = setup(); await f.subscribe();
  try {
    const payload = feishuPayload('', { type: 'audio', messageId: 'om_audio' });
    payload.event.message.content = '{"file_key":"file_MOCK_PRIVATE","duration":1000}'; payload.event.message.create_time = String(f.now());
    const cb = encryptedCallback(payload), decoded = decodeFeishu(mockApp, cb.raw, new Headers(cb.headers), Date.now(), true);
    assert.ok('message' in decoded); assert.equal(decoded.message.mediaCandidateStatus, 'unsupported_media'); assert.equal(decoded.message.mediaCandidate, undefined);
    assert.equal(JSON.stringify(decoded.message).includes('file_MOCK_PRIVATE'), false);
    assert.equal(f.media.receiveAuthenticated(decoded.message).media_state, 'unsupported_media');
    assert.deepEqual(f.media.describe(f.alice, eventId('om_audio')), { source: 'feishu', state: 'unsupported_media' });
    await assert.rejects(f.media.readImage(f.alice, { event_id: eventId('om_audio') }), code('media_not_available'));
    await f.bridge.pump();
    const delivery = f.calls.find(call => call.body.data?.media); assert.ok(delivery);
    assert.deepEqual(delivery.body.data.media, { source: 'feishu', state: 'unsupported_media', at_receipt: true });
    assert.equal(delivery.body.data.text, '[未同步：暂不支持此消息类型]');
    assert.equal(JSON.stringify(delivery.body).includes('file_MOCK_PRIVATE'), false);
    assert.equal(JSON.stringify(f.store.db.prepare('SELECT * FROM inbox').all()).includes('file_MOCK_PRIVATE'), false);
    assert.equal(f.downloads(), 0);
    const restarted = new MediaInputCandidate(f.bridge, { async download() { throw new Error('MUST_NOT_CALL'); } }, () => true, f.now);
    try { assert.deepEqual(restarted.describe(f.alice, eventId('om_audio')), { source: 'feishu', state: 'unsupported_media' }); }
    finally { restarted.close(); }
  } finally { f.close(); }
});
test('websocket audio is rejected before capturing any resource reference', () => {
  const payload = feishuPayload('', { type: 'audio', messageId: 'om_audio_ws' });
  payload.event.message.content = '{"file_key":"file_MOCK_PRIVATE","duration":1000}';
  const decoded = decodeFeishuWebSocket({ ...mockApp, ingress: 'websocket' }, { ...payload.event, app_id: mockApp.appId, tenant_key: mockApp.tenantKey, event_type: 'im.message.receive_v1' }, Date.now(), true);
  assert.ok('message' in decoded); assert.equal(decoded.message.mediaCandidateStatus, 'unsupported_media');
  assert.equal(decoded.message.mediaCandidate, undefined); assert.equal(JSON.stringify(decoded.message).includes('file_MOCK_PRIVATE'), false);
});
test('a forged audio capability is rejected at ingress and transport before any fetch or token access', async () => {
  const reference = { kind: 'audio', resourceType: 'file', resourceKey: 'file_MOCK' } as unknown as MediaReference;
  const f = setup(); let tokens = 0, requests = 0;
  const transport = new FeishuMediaTransport([mockApp], async () => { tokens++; return 'MOCK_TOKEN'; }, {}, (() => { requests++; throw new Error('MUST_NOT_CALL'); }) as typeof request);
  try {
    assert.throws(() => f.receive(reference), code('invalid_media_reference'));
    await assert.rejects(transport.download({ appId: mockApp.appId, messageId: 'om_MOCK', reference }, new AbortController().signal, () => {}), code('invalid_media_reference'));
    assert.equal(f.bridge.listPendingEvents(f.alice).events.length, 0); assert.equal(f.downloads(), 0); assert.equal(tokens, 0); assert.equal(requests, 0);
  } finally { transport.close(); f.close(); }
});
test('unlink during image download prevents result after await and clears downloaded bytes', async () => {
  let release!: () => void; const gate = new Promise<void>(r => { release = r; }); let entered!: () => void; const started = new Promise<void>(r => { entered = r; });
  const bytes = png(), transport: MediaTransport = { async download() { entered(); await gate; return { bytes, declaredMime: 'image/png' }; } };
  const f = setup(true, transport);
  try { f.receive(); const pending = f.media.read(f.alice, { event_id: eventId() }); await started; f.bridge.unlink(f.alice); release(); await assert.rejects(pending, code('event_not_found')); assert.ok(bytes.every(byte => byte === 0)); } finally { f.close(); }
});
test('transport fixes HTTPS host/path; token only goes in Authorization header', async () => {
  const seen: any[] = []; const fake = ((options: any, callback: (res: IncomingMessage) => void) => {
    seen.push(options); const req = new EventEmitter() as ClientRequest; req.end = (() => { queueMicrotask(() => callback(response([png()]))); return req; }) as typeof req.end; return req;
  }) as typeof request;
  const transport = new FeishuMediaTransport([mockApp], async () => 'MOCK_TOKEN', {}, fake);
  try { assert.deepEqual((await transport.download({ appId: mockApp.appId, messageId: 'om_MOCK', reference: image }, new AbortController().signal, () => {})).bytes, png()); assert.equal(seen[0].hostname, 'open.feishu.cn'); assert.equal(seen[0].port, 443); assert.equal(seen[0].headers.authorization, 'Bearer MOCK_TOKEN'); assert.equal(seen[0].path.includes('MOCK_TOKEN'), false); } finally { transport.close(); }
});
test('closing transport aborts token wait and prevents a later network request', async () => {
  let resolve!: (token: string) => void; let calls = 0; const token = new Promise<string>(r => { resolve = r; });
  const transport = new FeishuMediaTransport([mockApp], () => token, {}, (() => { calls++; throw new Error(); }) as typeof request);
  const pending = transport.download({ appId: mockApp.appId, messageId: 'om_MOCK', reference: image }, new AbortController().signal, () => {});
  transport.close(); await assert.rejects(pending, code('media_cancelled')); resolve('MOCK_TOKEN'); await new Promise(r => setImmediate(r)); assert.equal(calls, 0);
});

test('explicit shutdown releases references and fails closed on later reads/ingress', async () => {
  const f = setup(); try { f.receive(); f.media.close(); await assert.rejects(f.media.read(f.alice, { event_id: eventId() }), code('media_transport_closed')); assert.throws(() => f.receive(image, 'om_late'), code('media_transport_closed')); assert.equal(f.downloads(), 0); } finally { f.close(); }
});
test('reference expiry evicts in-memory capability; process restart cannot resurrect a media capability', async () => {
  const f = setup(); try {
    f.receive(); f.advance(MEDIA_LIMITS.referenceTtlMs); f.media.expireReferences(); await assert.rejects(f.media.read(f.alice, { event_id: eventId() }), code('media_not_available'));
    const restarted = new MediaInputCandidate(f.bridge, { async download() { throw new Error('MUST_NOT_CALL'); } }, () => true, f.now);
    try { await assert.rejects(restarted.read(f.alice, { event_id: eventId() }), code('media_not_available')); } finally { restarted.close(); }
  } finally { f.close(); }
});
test('concurrent image reads enforce same-event and global limits without duplicate downloads', async () => {
  let release!: () => void; const gate = new Promise<void>(r => { release = r; }); let calls = 0;
  const f = setup(true, { async download() { calls++; await gate; return { bytes: png(), declaredMime: 'image/png' }; } });
  try {
    for (const id of ['om_one', 'om_two', 'om_three']) f.receive(image, id);
    const one = f.media.readImage(f.alice, { event_id: eventId('om_one') });
    assert.equal(state(await f.media.readImage(f.alice, { event_id: eventId('om_one') })).state, 'media_busy');
    const two = f.media.readImage(f.alice, { event_id: eventId('om_two') });
    assert.equal(state(await f.media.readImage(f.alice, { event_id: eventId('om_three') })).state, 'media_busy');
    assert.equal(calls, MEDIA_LIMITS.maxConcurrent); release();
    for (const result of await Promise.all([one, two])) assert.equal(state(result).state, 'image_ready');
    assert.equal(state(await f.media.readImage(f.alice, { event_id: eventId('om_three') })).state, 'image_ready'); assert.equal(calls, 3);
  } finally { release(); f.close(); }
});
test('approval, lease, or revocation loss during image download hides results and clears downloaded bytes', async () => {
  for (const variant of ['approval', 'lease', 'revoked']) {
    const f = fixture(); f.bind(); let approved = true;
    let release!: () => void; const gate = new Promise<void>(r => { release = r; }); let entered!: () => void; const ready = new Promise<void>(r => { entered = r; });
    const bytes = png();
    const candidate = new MediaInputCandidate(f.bridge, { async download() { entered(); await gate; return { bytes, declaredMime: 'image/png' }; } }, () => approved, f.now);
    try {
      candidate.receiveAuthenticated(f.message({ messageId: 'om_media', contentStatus: 'unsupported', mediaCandidate: image }));
      const pending = candidate.readImage(f.alice, { event_id: eventId() }); await ready;
      if (variant === 'approval') approved = false; else if (variant === 'lease') f.alice.expiresAt = f.now(); else f.store.revoke(f.alice.id);
      release(); await assert.rejects(pending, code(variant === 'approval' ? 'media_processing_not_authorized' : 'unauthorized'));
      assert.ok(bytes.every(byte => byte === 0));
    } finally { candidate.close(); f.store.close(); }
  }
});
test('decoder preserves safe unsupported reasons without exposing resource content', () => {
  const f = setup(); try {
    for (const [type, raw, reason] of [['audio', '{"file_key":"file_MOCK","duration":60001}', 'unsupported_media'], ['image', '{}', 'invalid_media_reference'], ['sticker', '{}', 'unsupported_media']]) {
      const p = feishuPayload('', { type, messageId: `om_${type}` }); p.event.message.content = raw!;
      const cb = encryptedCallback(p), decoded = decodeFeishu(mockApp, cb.raw, new Headers(cb.headers), Date.now(), true);
      assert.ok('message' in decoded); assert.equal(decoded.message.mediaCandidateStatus, reason);
      assert.equal(f.media.receiveAuthenticated(decoded.message).media_state, reason);
    }
  } finally { f.close(); }
});
test('JPEG without a scan is rejected even when SOF dimensions are valid', () => {
  assert.throws(() => inspectMedia(Buffer.from([255,216,255,192,0,8,8,0,1,0,1,0,255,217]), 'image', 'image/jpeg'), code('invalid_media_content'));
});
