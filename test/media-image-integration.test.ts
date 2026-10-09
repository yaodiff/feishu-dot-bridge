/** Real decoder and MCP SDK with generated pixels, mocked download and synthetic credentials only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { sanitizeImage } from '../src/media-image.js';
import { inspectMedia } from '../src/media-policy.js';
import { MediaInputCandidate } from '../src/media-input.js';
import { mediaInputEnabled } from '../src/media-runtime.js';
import { makeApp, nodeServer } from '../src/http.js';
import { authenticatedWebSocketMessageHandler } from '../src/feishu-websocket.js';
import { BridgeError } from '../src/types.js';
import { fixture, mockApp, encryptedCallback, feishuPayload, verifyDelivery } from './fixtures.js';
const signal = () => new AbortController().signal;
const code = (expected: string) => (error: unknown) => error instanceof BridgeError && error.code === expected;
const pixelPng = () => sharp({ create: { width: 16, height: 12, channels: 4, background: { r: 20, g: 100, b: 190, alpha: 0.5 } } }).png().toBuffer();
const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'SYNTHETIC-image', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} };

test('real full decode strips EXIF/XMP/ICC, orients JPEG and preserves PNG alpha', async () => {
  const input = await sharp({ create: { width: 18, height: 12, channels: 3, background: '#ad4235' } }).jpeg().withMetadata({ orientation: 6 }).withExif({ IFD0: { Copyright: 'SYNTHETIC_METADATA_ONLY' } }).toBuffer();
  const before = await sharp(input).metadata(); assert.ok(before.exif);
  const result = await sanitizeImage(input, 'image/jpeg', signal()); const after = await sharp(result.bytes).metadata();
  assert.equal(result.mimeType, 'image/png'); assert.equal(after.width, 12); assert.equal(after.height, 18);
  for (const key of ['exif', 'xmp', 'iptc', 'icc', 'orientation'] as const) assert.equal(after[key], undefined);
  assert.equal(result.bytes.includes(Buffer.from('SYNTHETIC_METADATA_ONLY')), false);
  const transparent = await sanitizeImage(await pixelPng(), 'image/png', signal()); assert.equal((await sharp(transparent.bytes).metadata()).hasAlpha, true);
});
test('real decoder rejects malformed pixels even when the header validator accepts dimensions', async () => {
  const bytes = await pixelPng(); const at = bytes.indexOf(Buffer.from('IDAT')); assert.ok(at > 0); bytes[at + 5] = bytes[at + 5]! ^ 255;
  assert.equal(inspectMedia(bytes, 'image', 'image/png').width, 16);
  await assert.rejects(sanitizeImage(bytes, 'image/png', signal()), code('invalid_media_content'));
});
test('unsupported input/extra bytes and aborted worker never return an image', async () => {
  await assert.rejects(async () => sanitizeImage(Buffer.from('<svg><image href="https://example.invalid"/></svg>'), 'image/svg+xml', signal()), code('unsupported_image_format'));
  await assert.rejects(async () => sanitizeImage(Buffer.concat([await pixelPng(), Buffer.from('SYNTHETIC_TRAILING')]), 'image/png', signal()), code('invalid_media_content'));
  const controller = new AbortController(); const pending = sanitizeImage(await pixelPng(), 'image/png', controller.signal); controller.abort(); await assert.rejects(pending, code('media_cancelled'));
});
test('sanitizer bounds output independently of compressed input', async () => {
  const bytes = await sharp(randomBytes(2000 * 2000 * 3), { raw: { width: 2000, height: 2000, channels: 3 } }).jpeg({ quality: 12 }).toBuffer();
  assert.ok(bytes.length < 4 * 1024 * 1024); await assert.rejects(sanitizeImage(bytes, 'image/jpeg', signal()), code('invalid_media_content'));
});
test('media deployment mode is default-off and fails closed on unrecognized values', () => {
  assert.equal(mediaInputEnabled({}), false); assert.equal(mediaInputEnabled({ FEISHU_MEDIA_INPUT: 'disabled' }), false);
  assert.equal(mediaInputEnabled({ FEISHU_MEDIA_INPUT: 'images-v1' }), true);
  for (const value of ['true', 'all', 'audio', '', 'images']) assert.throws(() => mediaInputEnabled({ FEISHU_MEDIA_INPUT: value }), code('invalid_media_mode'));
});
test('signed ingress → source event notice → owned MCP read returns sanitized image with ten-tool opt-in', async () => {
  const f = fixture(); f.bind(); await f.subscribe(); let downloads = 0; const input = await pixelPng();
  const media = new MediaInputCandidate(f.bridge, { async download(request, _signal, check) { check(); downloads++; assert.equal(request.messageId, 'om_image'); assert.equal(request.reference.resourceKey, 'img_SYNTHETIC'); return { bytes: Buffer.from(input), declaredMime: 'image/png' }; } }, () => true, f.now);
  const app = makeApp({ authMode: 'oauth', publicUrl: 'http://127.0.0.1', issuer: 'https://MOCK.invalid', apps: [mockApp], allowedOrigins: [] }, f.bridge,
    { async authenticate(header) { if (header !== 'Bearer MOCK') throw new BridgeError('unauthorized', 401); return f.alice; } }, media);
  const rpc = async (method: string, params: Record<string, unknown> = {}, auth = true) => app(new Request('http://127.0.0.1/mcp', { method: 'POST', headers: {
    'content-type': 'application/json', accept: 'application/json,text/event-stream', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method,
    ...(method === 'tools/call' ? { 'Mcp-Name': String(params.name) } : {}), ...(auth ? { authorization: 'Bearer MOCK' } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: meta } }) }));
  const call = async (name: string, args: unknown = {}) => (await (await rpc('tools/call', { name, arguments: args })).json()).result;
  try {
    const catalog = (await (await rpc('tools/list')).json()).result.tools; assert.equal(catalog.length, 10);
    const tool = catalog.find((x: any) => x.name === 'get_event_image'); assert.ok(tool); assert.equal(tool.inputSchema.additionalProperties, false); assert.equal(tool.annotations.readOnlyHint, true);
    const events = (await (await rpc('events/list')).json()).result.events; assert.ok(events[0].payloadSchema.properties.media);
    const payload = feishuPayload('', { type: 'image', messageId: 'om_image' }); payload.event.message.content = '{"image_key":"img_SYNTHETIC"}'; payload.event.message.create_time = String(f.now());
    const cb = encryptedCallback(payload); const receipt = await app(new Request('http://127.0.0.1/feishu/events/cli_mock', { method: 'POST', headers: cb.headers, body: cb.raw })); assert.equal(receipt.status, 200);
    await f.bridge.pump(); const delivery = f.calls.find(x => x.body.data?.media); assert.ok(delivery); verifyDelivery(f.secret, delivery);
    assert.deepEqual(delivery.body.data.media, { kind: 'image', state: 'media_available', expires_at: new Date(f.now() + 900000).toISOString(), source: 'feishu', at_receipt: true });
    assert.equal(JSON.stringify(delivery.body).includes('img_SYNTHETIC'), false); assert.equal(downloads, 0);
    const page = JSON.parse((await call('list_pending_events')).content[0].text), event = page.events[0]; assert.equal(event.media.kind, 'image');
    assert.equal(JSON.parse((await call('get_event', { event_id: event.event_id })).content[0].text).media.state, 'media_available');
    const result = await call('get_event_image', { event_id: event.event_id }); assert.ok(!result.isError); assert.equal(result.content[1].type, 'image'); assert.equal(result.content[1].mimeType, 'image/png');
    assert.equal((await sharp(Buffer.from(result.content[1].data, 'base64')).metadata()).width, 16); assert.equal(downloads, 1);
    assert.equal((await rpc('tools/call', { name: 'get_event_image', arguments: { event_id: event.event_id } }, false)).status, 401);
    assert.equal((await call('get_event_image', { event_id: event.event_id, url: 'https://evil.invalid' })).isError, true);
    f.bridge.unlink(f.alice); assert.equal((await call('get_event_image', { event_id: event.event_id })).content[0].text, 'event_not_found'); assert.equal(downloads, 1);
  } finally { media.close(); f.store.close(); }
});
test('authenticated websocket captures media only when explicitly enabled', async () => {
  const received: any[] = []; const app = { ...mockApp, ingress: 'websocket' as const };
  const raw = { ...feishuPayload('', { type: 'image' }).event, app_id: app.appId, tenant_key: app.tenantKey, event_type: 'im.message.receive_v1' };
  raw.message.content = '{"image_key":"img_SYNTHETIC"}';
  await authenticatedWebSocketMessageHandler(app, message => received.push(message))(raw);
  await authenticatedWebSocketMessageHandler(app, message => received.push(message), { mediaEnabled: true })(raw);
  assert.equal(received[0].mediaCandidate, undefined); assert.equal(received[1].mediaCandidate.resourceKey, 'img_SYNTHETIC');
});

test('media notice and inbox commit atomically; retry after failed insert succeeds once', async () => {
  const f = fixture(); f.bind(); await f.subscribe();
  const media = new MediaInputCandidate(f.bridge, { async download() { throw new Error('MUST_NOT_FETCH'); } }, () => true, f.now);
  const message = f.message({ messageId: 'om_atomic', contentStatus: 'unsupported', mediaCandidate: { kind: 'image', resourceType: 'image', resourceKey: 'img_ATOMIC' } });
  try {
    f.store.db.exec("CREATE TRIGGER fail_media BEFORE INSERT ON jobs WHEN NEW.kind='event' BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_INSERT_FAILURE'); END");
    assert.throws(() => media.receiveAuthenticated(message)); assert.equal(f.bridge.listPendingEvents(f.alice).events.length, 0);
    f.store.db.exec('DROP TRIGGER fail_media'); assert.equal(media.receiveAuthenticated(message).state, 'accepted'); assert.equal(media.receiveAuthenticated(message).state, 'duplicate');
    const event = f.bridge.listPendingEvents(f.alice).events[0]!; assert.equal(media.describe(f.alice, event.event_id)?.state, 'media_available');
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='event'").get()!.n, 1);
  } finally { media.close(); f.store.close(); }
});
test('persisted notices stay explicit after restart/expiry and retain parser rejection reason', async () => {
  const f = fixture(); f.bind(); await f.subscribe(); const noFetch = { async download() { throw new Error('MUST_NOT_FETCH'); } };
  const media = new MediaInputCandidate(f.bridge, noFetch, () => true, f.now);
  const restarted = new MediaInputCandidate(f.bridge, noFetch, () => true, f.now);
  try {
    media.receiveAuthenticated(f.message({ messageId: 'om_restart', contentStatus: 'unsupported', mediaCandidate: { kind: 'image', resourceType: 'image', resourceKey: 'img_RESTART' } }));
    media.receiveAuthenticated(f.message({ messageId: 'om_rejected', contentStatus: 'unsupported', mediaCandidateStatus: 'invalid_media_reference' }));
    const events = f.bridge.listPendingEvents(f.alice).events;
    assert.equal(restarted.describe(f.alice, events[0]!.event_id)?.state, 'media_unavailable_after_restart');
    assert.equal(restarted.describe(f.alice, events[1]!.event_id)?.state, 'invalid_media_reference');
    await assert.rejects(restarted.readImage(f.alice, { event_id: events[0]!.event_id }), code('media_not_available'));
    f.advance(900000); assert.equal(restarted.describe(f.alice, events[0]!.event_id)?.state, 'media_expired');
  } finally { media.close(); restarted.close(); f.store.close(); }
});
test('metadata refuses source-message drift and tolerated timestamp skew does not permanently expire input', () => {
  const f = fixture(); f.bind(); const media = new MediaInputCandidate(f.bridge, { async download() { throw new Error('MUST_NOT_FETCH'); } }, () => true, f.now);
  try {
    assert.equal(media.receiveAuthenticated(f.message({ messageId: 'om_future', timestamp: new Date(f.now() + 1000).toISOString(), contentStatus: 'unsupported', mediaCandidate: { kind: 'image', resourceType: 'image', resourceKey: 'img_FUTURE' } })).media_state, 'media_available');
    f.advance(1000); const event = f.bridge.listPendingEvents(f.alice).events[0]!; assert.equal(media.describe(f.alice, event.event_id)?.state, 'media_available');
    f.store.db.prepare('UPDATE inbox SET messageId=? WHERE id=?').run('om_drifted', event.event_id); assert.equal(media.describe(f.alice, event.event_id)?.state, 'media_error');
  } finally { media.close(); f.store.close(); }
});
test('caller cancellation propagates through actual MCP SDK into active download', async () => {
  const f = fixture(); f.bind(); let started!: () => void; const ready = new Promise<void>(r => { started = r; }); let cancelled = false;
  const media = new MediaInputCandidate(f.bridge, { async download(_request, signal) { started(); return await new Promise((_, reject) => { signal.addEventListener('abort', () => { cancelled = true; reject(new BridgeError('media_cancelled')); }, { once: true }); }); } }, () => true, f.now);
  media.receiveAuthenticated(f.message({ messageId: 'om_cancel', contentStatus: 'unsupported', mediaCandidate: { kind: 'image', resourceType: 'image', resourceKey: 'img_CANCEL' } }));
  const id = f.bridge.listPendingEvents(f.alice).events[0]!.event_id;
  const app = makeApp({ authMode: 'oauth', publicUrl: 'http://127.0.0.1', issuer: 'https://MOCK.invalid', apps: [mockApp], allowedOrigins: [] }, f.bridge, { async authenticate() { return f.alice; } }, media);
  const controller = new AbortController();
  try {
    const pending = app(new Request('http://127.0.0.1/mcp', { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json', accept: 'application/json,text/event-stream', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': 'get_event_image' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_event_image', arguments: { event_id: id }, _meta: meta } }) }));
    await ready; controller.abort(); const response = await pending; assert.equal(cancelled, true); assert.equal(response.status, 499);
  } finally { media.close(); f.store.close(); }
});


test('real HTTP client disconnect aborts the Request passed through the Node adapter', async () => {
  let started!: () => void, cancelled!: () => void;
  const ready = new Promise<void>(r => { started = r; }), cancellation = new Promise<void>(r => { cancelled = r; });
  const hosts: string[] = [];
  const server = nodeServer(async request => { started(); await new Promise<void>(resolve => request.signal.addEventListener('abort', () => { cancelled(); resolve(); }, { once: true })); return new Response('cancelled'); }, 'http://127.0.0.1', hosts);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port; hosts.push(`127.0.0.1:${port}`);
  const controller = new AbortController();
  try {
    const pending = fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', body: '{}', signal: controller.signal });
    await ready; controller.abort(); await assert.rejects(pending);
    await Promise.race([cancellation, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('disconnect did not cancel')), 1000))]);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('polling-only unsupported/restarted media keeps an explicit generic unavailable notice', () => {
  const f = fixture(); f.bind(); const noFetch = { async download() { throw new Error('MUST_NOT_FETCH'); } };
  const media = new MediaInputCandidate(f.bridge, noFetch, () => true, f.now), restarted = new MediaInputCandidate(f.bridge, noFetch, () => true, f.now);
  try {
    media.receiveAuthenticated(f.message({ messageId: 'om_poll_invalid', contentStatus: 'unsupported', mediaCandidateStatus: 'invalid_media_reference' }));
    media.receiveAuthenticated(f.message({ messageId: 'om_poll_image', contentStatus: 'unsupported', mediaCandidate: { kind: 'image', resourceType: 'image', resourceKey: 'img_POLL' } }));
    const events = f.bridge.listPendingEvents(f.alice).events;
    assert.equal(media.describe(f.alice, events[0]!.event_id)?.state, 'media_not_available');
    assert.equal(restarted.describe(f.alice, events[1]!.event_id)?.state, 'media_not_available');
  } finally { media.close(); restarted.close(); f.store.close(); }
});

test('activation fence rejects delayed historical media without downloading or reviving references', async () => {
  const f = fixture(); f.bind(); let downloads = 0;
  const media = new MediaInputCandidate(f.bridge, { async download() { downloads++; return { bytes: await pixelPng(), declaredMime: 'image/png' }; } }, () => true, f.now);
  try {
    assert.equal(media.receiveAuthenticated(f.message({ messageId: 'om_old', timestamp: new Date(f.now() - 1).toISOString(), contentStatus: 'unsupported', mediaCandidate: { kind: 'image', resourceType: 'image', resourceKey: 'img_OLD' } })).media_state, 'media_before_activation');
    const event = f.bridge.listPendingEvents(f.alice).events[0]!; await assert.rejects(media.readImage(f.alice, { event_id: event.event_id }), code('media_not_available')); assert.equal(downloads, 0);
  } finally { media.close(); f.store.close(); }
});
