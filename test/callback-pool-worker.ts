/** Synthetic, loopback-only integration scenarios. No live endpoint is ever contacted. */
import assert from 'node:assert/strict';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createHttpServer, type ServerResponse } from 'node:http';
import { connect as tcpConnect } from 'node:net';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { Duplex } from 'node:stream';
import type { TLSSocket } from 'node:tls';
import { OpenAiManagedProxyCallback, CALLBACK_POOL_LIMITS, type CallbackPostDiagnostic } from '../src/callback-proxy-candidate.js';

const HOST = 'connectors.api.openai.com';
const ORIGIN = `https://${HOST}`;
const scenario = process.argv[2]!;
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function eventually(predicate: () => boolean, timeout = 2000, label = 'condition'): Promise<void> {
  const start = performance.now();
  while (!predicate()) { if (performance.now() - start > timeout) assert.fail(`Timed out: ${label}`); await delay(5); }
}
const settled = <T>(promise: Promise<T>) => promise.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }));
function headers(id: string) { return { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': '1234567890', 'webhook-signature': `v1,MOCK_SIGNATURE_${id}`, 'x-mcp-subscription-id': `sub_MOCK_${id}` }; }
const body = (id: string) => JSON.stringify({ id, payload: `MOCK_BODY_${id}`, unicode: '界' });
type Mode = 'normal' | 'connect-stall' | 'connect-trickle' | 'tls-stall' | 'tls-trickle';
interface RecordSeen { id: string; path: string; body: string; signature: string; subscription: string; connection: number; host: string; }
const result: Record<string, unknown> = { scenario };
const sockets = new Set<Duplex>();
const targetSockets = new Set<TLSSocket>();
const timers = new Set<NodeJS.Timeout>();
const holds = new Map<string, ServerResponse>();
const records: RecordSeen[] = [];
const serverNames: string[] = [];
const errors: Error[] = [];
let connects = 0, maxSockets = 0, targetConnections = 0, active = 0, maxActive = 0;
let mode: Mode = 'normal', connectDelay = 0, modeForConnect: ((n: number) => Mode) | undefined;
function track(socket: Duplex) { sockets.add(socket); maxSockets = Math.max(maxSockets, sockets.size); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); }
function later(fn: () => void, ms: number) { const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms); timers.add(timer); return timer; }
const target = createHttpsServer({ key: readFileSync(process.env.MOCK_KEY!), cert: readFileSync(process.env.MOCK_CERT!) }, async (req, res) => {
  active++; maxActive = Math.max(maxActive, active); let ended = false;
  const finish = () => { if (!ended) { ended = true; active--; } };
  res.once('close', finish); res.once('finish', finish);
  try {
    const parts: Buffer[] = []; for await (const part of req) parts.push(Buffer.from(part));
    const record: RecordSeen = { id: String(req.headers['webhook-id'] ?? ''), path: req.url!, body: Buffer.concat(parts).toString(), signature: String(req.headers['webhook-signature'] ?? ''), subscription: String(req.headers['x-mcp-subscription-id'] ?? ''), connection: (req.socket as TLSSocket & { mockConnection: number }).mockConnection, host: String(req.headers.host) };
    records.push(record);
    assert.equal((req.socket as TLSSocket).encrypted, true); assert.equal(req.headers.authorization, undefined); assert.equal(req.headers.cookie, undefined); assert.equal(req.headers['proxy-authorization'], undefined);
    if (req.method === 'HEAD') { res.setHeader('content-length', Buffer.byteLength(JSON.stringify(record))); res.end(); return; }
    if (req.url!.startsWith('/hold/')) { holds.set(req.url!.slice(6), res); return; }
    if (req.url === '/hang') return;
    if (req.url === '/drop') { req.socket.destroy(); return; }
    if (req.url === '/close') { res.setHeader('connection', 'close'); res.end(JSON.stringify(record)); return; }
    if (req.url === '/peer') { const socket = req.socket; res.end(JSON.stringify(record)); later(() => socket.end(), 30); return; }
    if (req.url === '/race') { const socket = req.socket; res.end(JSON.stringify(record)); setImmediate(() => socket.end()); return; }
    if (req.url!.startsWith('/delay/')) { later(() => res.end(JSON.stringify(record)), Number(req.url!.slice(7))); return; }
    if (req.url === '/trickle') { res.writeHead(200); res.write('x'); const timer = setInterval(() => { if (res.destroyed) { clearInterval(timer); timers.delete(timer); } else res.write('x'); }, 100); timers.add(timer); return; }
    res.end(JSON.stringify(record));
  } catch (error) { errors.push(error as Error); res.destroy(); }
});
target.keepAliveTimeout = 120000; target.headersTimeout = 130000;
target.on('connection', track);
target.on('secureConnection', socket => { targetConnections++; (socket as TLSSocket & { mockConnection: number }).mockConnection = targetConnections; targetSockets.add(socket); socket.once('close', () => targetSockets.delete(socket)); serverNames.push(socket.servername || ''); });
target.on('tlsClientError', () => {});
await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
const targetPort = (target.address() as { port: number }).port;
const proxy = createHttpServer();
proxy.on('connection', track);
proxy.on('connect', (req, socket, head) => {
  connects++; socket.on('error', () => {}); socket.on('end', () => socket.end());
  try { assert.equal(req.url, `${HOST}:443`); assert.equal(req.headers.host, `${HOST}:443`); assert.equal(req.headers['proxy-authorization'], undefined); assert.equal(head.length, 0); } catch (error) { errors.push(error as Error); socket.destroy(); return; }
  const selectedMode = modeForConnect?.(connects) ?? mode;
  if (selectedMode === 'connect-stall') { socket.resume(); return; }
  if (selectedMode === 'connect-trickle') { socket.resume(); socket.write('HTTP/1.1 200 Connection Established\r\nX-Synthetic: '); const timer = setInterval(() => { if (socket.destroyed) { clearInterval(timer); timers.delete(timer); } else socket.write('x'); }, 100); timers.add(timer); return; }
  if (selectedMode === 'tls-stall' || selectedMode === 'tls-trickle') {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); socket.on('data', () => {});
    if (selectedMode === 'tls-trickle') socket.once('data', () => { socket.write(Buffer.from([0x16, 0x03, 0x03, 0x03, 0xe8, 0x02])); const timer = setInterval(() => { if (socket.destroyed) { clearInterval(timer); timers.delete(timer); } else socket.write(Buffer.from([0])); }, 100); timers.add(timer); });
    return;
  }
  const establish = () => {
    if (socket.destroyed) return;
    // All CONNECT authorities are validated above, but fixture routing is always loopback.
    const upstream = tcpConnect(targetPort, '127.0.0.1', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); socket.pipe(upstream); upstream.pipe(socket); });
    track(upstream); upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
    upstream.on('close', () => socket.destroy()); socket.on('close', () => upstream.destroy());
  };
  if (connectDelay) later(establish, connectDelay); else establish();
});
await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
const proxyPort = (proxy.address() as { port: number }).port;
const env = { CODEX_NETWORK_PROXY_ACTIVE: '1', HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`, NO_PROXY: '*' };
const diagnostics: CallbackPostDiagnostic[] = [];
let hook: ((item: CallbackPostDiagnostic) => void) | undefined;
const transports: OpenAiManagedProxyCallback[] = [];
const create = () => { const c = new OpenAiManagedProxyCallback(env, item => { assert.ok(Object.isFrozen(item)); diagnostics.push(item); hook?.(item); }); transports.push(c); return c; };
const candidate = create();
const post = (id: string, path = '/echo', signal?: AbortSignal, c = candidate) => c.post(`${ORIGIN}${path}`, body(id), headers(id), { signal });
function echo(response: { status: number; body: string }, id: string, path = '/echo') {
  assert.equal(response.status, 200); const record = JSON.parse(response.body) as RecordSeen;
  assert.equal(record.id, id); assert.equal(record.path, path); assert.equal(record.body, body(id)); assert.equal(record.signature, headers(id)['webhook-signature']); assert.equal(record.subscription, headers(id)['x-mcp-subscription-id']); assert.equal(record.host, HOST);
}
function release(label: string, close = false) { const response = holds.get(label); assert.ok(response, `Missing hold ${label}`); if (close) response.setHeader('connection', 'close'); response.end('{}'); holds.delete(label); }
async function expectFailure(promise: Promise<unknown>, code: string) { const outcome = await settled(promise); assert.equal(outcome.ok, false); if (!outcome.ok) assert.equal(outcome.error, code); return outcome; }
async function noSockets() { await eventually(() => sockets.size === 0 && targetSockets.size === 0, 2000, 'all fixture sockets closed'); }
function safeDiagnostics() {
  for (const item of diagnostics) {
    assert.ok(Object.isFrozen(item));
    assert.ok(Object.keys(item).every(key => ['stage', 'outcome', 'reason', 'elapsedMs', 'httpStatus', 'hostname'].includes(key)));
    assert.ok(['validation', 'proxy_connect', 'tls_handshake', 'request', 'response'].includes(item.stage));
    assert.ok(['started', 'succeeded', 'failed'].includes(item.outcome));
    assert.ok(['none', 'invalid_callback', 'invalid_callback_headers', 'callback_request_too_large', 'callback_timeout', 'callback_proxy_connect_failed', 'callback_tls_failed', 'callback_failed', 'callback_redirect_rejected', 'callback_response_too_large', 'callback_upgrade_rejected'].includes(item.reason));
    assert.equal(item.hostname === undefined || item.hostname === HOST, true); assert.ok(Number.isInteger(item.elapsedMs) && item.elapsedMs >= 0);
  }
  assert.doesNotMatch(JSON.stringify(diagnostics), /MOCK|SECRET|SIGNATURE|BODY|PRIVATE|\?|https?:\/\//);
}
try {
  assert.deepEqual(CALLBACK_POOL_LIMITS, { connections: 2, queued: 32, idleMs: 30000, requestsPerConnection: 100 });
  if (scenario === 'reuse-isolation') {
    for (let i = 0; i < 20; i++) echo(await post(`MOCK_${i}`, `/echo?value=${i}%2Ftwo`), `MOCK_${i}`, `/echo?value=${i}%2Ftwo`);
    assert.equal(connects, 1); assert.equal(targetConnections, 1); assert.equal(records.length, 20);
    const before = connects;
    for (const url of ['https://evil.invalid/', 'https://127.0.0.1/', `${ORIGIN}:444/`, `https://${HOST}.evil/`]) await expectFailure(candidate.post(url, '{}', headers('MOCK_INVALID')), 'invalid_callback');
    await expectFailure(candidate.post(ORIGIN, '{}', { ...headers('MOCK_INVALID'), host: 'evil.invalid' }), 'invalid_callback_headers');
    assert.equal(connects, before); echo(await post('MOCK_FINAL'), 'MOCK_FINAL'); assert.equal(connects, 1);
    const probe = await candidate.probe(); assert.equal(probe.status, 200); assert.equal(probe.body, '');
    const probeRecord = records.at(-1)!; assert.equal(probeRecord.id, ''); assert.equal(probeRecord.signature, ''); assert.equal(probeRecord.subscription, ''); assert.equal(probeRecord.body, '');
    echo(await post('MOCK_AFTER_PROBE'), 'MOCK_AFTER_PROBE'); assert.equal(connects, 1);
    const second = create(); echo(await post('MOCK_SEPARATE', '/echo', undefined, second), 'MOCK_SEPARATE'); assert.equal(connects, 2, 'Transport instances may not share a global Agent');
  } else if (scenario === 'concurrency-fifo') {
    const a = post('MOCK_A', '/hold/a'), b = post('MOCK_B', '/hold/b');
    await eventually(() => holds.size === 2); const pending = Array.from({ length: 10 }, (_, i) => post(`MOCK_Q${i}`, '/delay/15'));
    await delay(30); assert.equal(records.length, 2); assert.equal(connects, 2);
    release('a'); await a; await Promise.all(pending); release('b'); await b;
    assert.deepEqual(records.slice(2).map(record => record.id), Array.from({ length: 10 }, (_, i) => `MOCK_Q${i}`)); assert.equal(connects, 2); assert.equal(maxActive, 2);
  } else if (scenario === 'queue-saturation-cancel') {
    const a = post('MOCK_A', '/hold/a'), b = post('MOCK_B', '/hold/b'); await eventually(() => holds.size === 2);
    const controllers = Array.from({ length: 32 }, () => new AbortController());
    const queued = controllers.map((controller, i) => settled(post(`MOCK_Q${i}`, '/echo', controller.signal)));
    const start = performance.now(); await expectFailure(post('MOCK_OVERFLOW'), 'callback_failed'); assert.ok(performance.now() - start < 500); assert.equal(connects, 2);
    controllers.forEach(controller => controller.abort(new Error('MOCK_PRIVATE_ABORT_REASON')));
    const outcomes = await Promise.all(queued); assert.ok(outcomes.every(outcome => !outcome.ok && outcome.error === 'callback_timeout')); assert.equal(records.length, 2);
    release('a'); release('b'); await Promise.all([a, b]); echo(await post('MOCK_AFTER'), 'MOCK_AFTER'); assert.equal(connects, 2);
    const preAborted = new AbortController(); preAborted.abort(); await expectFailure(post('MOCK_PRE', '/echo', preAborted.signal), 'callback_timeout'); assert.equal(records.length, 3);
  } else if (scenario === 'abort-before-connect-socket') {
    const controller = new AbortController(); let abortedAtDiagnostic = false;
    hook = item => { if (item.stage === 'proxy_connect' && item.outcome === 'started') { abortedAtDiagnostic = true; controller.abort(new Error('MOCK_PRIVATE_ABORT')); } };
    const start = performance.now(); await expectFailure(post('MOCK_PRE_SOCKET', '/echo', controller.signal), 'callback_timeout'); hook = undefined;
    assert.equal(abortedAtDiagnostic, true); assert.ok(performance.now() - start < 500); await delay(30); assert.equal(records.length, 0); assert.equal(connects, 0); await noSockets();
    echo(await post('MOCK_AFTER_PRE_SOCKET'), 'MOCK_AFTER_PRE_SOCKET'); assert.equal(connects, 1);
  } else if (scenario === 'abort-after-release') {
    const controller = new AbortController(); echo(await post('MOCK_COMPLETED', '/echo', controller.signal), 'MOCK_COMPLETED');
    const active = post('MOCK_NEW_OWNER', '/hold/new-owner'); await eventually(() => holds.has('new-owner'));
    controller.abort(new Error('MOCK_STALE_ABORT')); await delay(30); assert.equal(connects, 1); release('new-owner'); await active;
    echo(await post('MOCK_AFTER_STALE_ABORT'), 'MOCK_AFTER_STALE_ABORT'); assert.equal(connects, 1);
  } else if (scenario.startsWith('cancel-')) {
    const phase = scenario.slice(7); const controller = new AbortController();
    if (phase === 'connect') modeForConnect = n => n === 1 ? 'connect-stall' : 'normal';
    if (phase === 'tls') modeForConnect = n => n === 1 ? 'tls-stall' : 'normal';
    const pending = settled(post('MOCK_CANCEL', phase === 'active' ? '/hold/cancel' : '/echo', controller.signal));
    await eventually(() => phase === 'active' ? holds.has('cancel') : diagnostics.some(item => item.stage === (phase === 'tls' ? 'tls_handshake' : 'proxy_connect') && item.outcome === 'started'));
    const neighbor = post('MOCK_NEIGHBOR', '/hold/neighbor'); await eventually(() => holds.has('neighbor'));
    const start = performance.now(); controller.abort(new Error('MOCK_PRIVATE_ABORT_REASON'));
    const outcome = await pending; assert.deepEqual(outcome, { ok: false, error: 'callback_timeout' }); assert.ok(performance.now() - start < 500);
    release('neighbor'); await neighbor; echo(await post('MOCK_AFTER'), 'MOCK_AFTER'); assert.equal(connects, 2, 'Unrelated connection must survive request-local cancellation');
  } else if (scenario === 'queue-total-deadline') {
    const a = post('MOCK_A', '/hold/a'), b = post('MOCK_B', '/hold/b'); await eventually(() => holds.size === 2);
    const start = performance.now(); const queued = settled(post('MOCK_QUEUED_TIMEOUT', '/trickle'));
    await delay(6000); assert.equal(records.length, 2); release('a'); release('b'); await Promise.all([a, b]);
    await eventually(() => records.some(record => record.id === 'MOCK_QUEUED_TIMEOUT')); result.queueWaitMs = Math.round(performance.now() - start);
    const outcome = await queued; const elapsed = performance.now() - start; assert.deepEqual(outcome, { ok: false, error: 'callback_timeout' }); assert.ok(elapsed >= 14900 && elapsed < 17000, `Queue-inclusive deadline: ${elapsed}ms`); result.totalMs = Math.round(elapsed);
  } else if (scenario === 'queue-connect-total-deadline') {
    const a = post('MOCK_A', '/hold/a'), b = post('MOCK_B', '/hold/b'); await eventually(() => holds.size === 2);
    const start = performance.now(); const queued = settled(post('MOCK_QUEUED_CONNECT_TIMEOUT'));
    await delay(6000); assert.equal(records.length, 2); mode = 'connect-stall'; release('a', true); release('b', true); await Promise.all([a, b]);
    await eventually(() => connects === 3); result.queueWaitMs = Math.round(performance.now() - start);
    const outcome = await queued; const elapsed = performance.now() - start; assert.deepEqual(outcome, { ok: false, error: 'callback_timeout' }); assert.ok(elapsed >= 14900 && elapsed < 16000, `Queue plus CONNECT must share 15s budget: ${elapsed}ms`); result.totalMs = Math.round(elapsed); assert.equal(records.length, 2);
  } else if (scenario === 'connect-deadline' || scenario === 'tls-deadline') {
    mode = scenario === 'connect-deadline' ? 'connect-trickle' : 'tls-trickle';
    const start = performance.now(); await expectFailure(post('MOCK_DEADLINE'), scenario === 'connect-deadline' ? 'callback_proxy_connect_failed' : 'callback_timeout'); const elapsed = performance.now() - start;
    const expected = scenario === 'connect-deadline' ? 12000 : 15000; assert.ok(elapsed >= expected - 100 && elapsed < expected + 2000); result.totalMs = Math.round(elapsed);
  } else if (scenario === 'peer-close-no-replay') {
    echo(await post('MOCK_CLOSE', '/close'), 'MOCK_CLOSE', '/close'); echo(await post('MOCK_AFTER_CLOSE'), 'MOCK_AFTER_CLOSE'); assert.equal(connects, 2);
    echo(await post('MOCK_PEER', '/peer'), 'MOCK_PEER', '/peer'); await noSockets(); echo(await post('MOCK_AFTER_PEER'), 'MOCK_AFTER_PEER'); assert.equal(connects, 3);
    const beforeConnect = connects; await expectFailure(post('MOCK_DROPPED', '/drop'), 'callback_failed'); assert.equal(connects, beforeConnect); assert.equal(records.filter(record => record.id === 'MOCK_DROPPED').length, 1);
    echo(await post('MOCK_RECOVERED'), 'MOCK_RECOVERED'); assert.equal(connects, beforeConnect + 1);
    for (let i = 0; i < 15; i++) { await settled(post(`MOCK_RACE${i}`, '/race')); await settled(post(`MOCK_RACENEXT${i}`)); }
    for (const id of new Set(records.map(record => record.id))) assert.ok(records.filter(record => record.id === id).length <= 1, `Hidden replay: ${id}`);
    assert.ok(connects <= 35); result.noReplayRequestCount = records.length;
  } else if (scenario === 'stale-at-assignment') {
    echo(await post('MOCK_WARM'), 'MOCK_WARM'); let destroyed = false;
    hook = item => { if (!destroyed && item.stage === 'request' && item.outcome === 'started') { destroyed = true; for (const entry of (candidate as unknown as { tunnels: Set<{ socket?: TLSSocket }> }).tunnels) entry.socket?.destroy(); } };
    await expectFailure(post('MOCK_STALE'), 'callback_failed'); hook = undefined;
    assert.equal(connects, 1, 'A stale reused socket must not silently create a replacement'); assert.ok(records.filter(record => record.id === 'MOCK_STALE').length <= 1);
    echo(await post('MOCK_AFTER_STALE'), 'MOCK_AFTER_STALE'); assert.equal(connects, 2);
  } else if (scenario === 'request-cap') {
    for (let i = 0; i < 101; i++) echo(await post(`MOCK_CAP${i}`), `MOCK_CAP${i}`);
    assert.equal(connects, 2); const counts = new Map<number, number>(); for (const record of records) counts.set(record.connection, (counts.get(record.connection) ?? 0) + 1);
    assert.deepEqual([...counts.values()], [100, 1]); result.requestsPerConnection = [...counts.values()];
  } else if (scenario === 'idle-ttl') {
    echo(await post('MOCK_WARM'), 'MOCK_WARM'); const start = performance.now(); await delay(29000); assert.ok(sockets.size > 0, 'TTL must not evict before 30s');
    await eventually(() => sockets.size === 0, 3000, '30s idle eviction'); const elapsed = performance.now() - start; assert.ok(elapsed >= 29900 && elapsed < 32000); result.idleEvictionMs = Math.round(elapsed);
    echo(await post('MOCK_AFTER_IDLE'), 'MOCK_AFTER_IDLE'); assert.equal(connects, 2);
  } else if (scenario === 'close-shutdown') {
    const a = settled(post('MOCK_ACTIVE', '/hold/active')), b = post('MOCK_IDLE'); await eventually(() => holds.has('active')); await b;
    const c = settled(post('MOCK_ACTIVE2', '/hold/active2')); await eventually(() => holds.has('active2'));
    const queued = Array.from({ length: 4 }, (_, i) => settled(post(`MOCK_QUEUED${i}`))); await delay(10);
    const start = performance.now(); candidate.close(); candidate.close(); const outcomes = await Promise.all([a, c, ...queued]); assert.ok(outcomes.every(outcome => !outcome.ok && outcome.error === 'callback_failed')); await noSockets(); assert.ok(performance.now() - start < 1000);
    await expectFailure(post('MOCK_CLOSED'), 'callback_failed'); assert.equal(connects, 2); assert.equal(records.length, 3);
    const idle = create(); echo(await post('MOCK_IDLE_CLOSE', '/echo', undefined, idle), 'MOCK_IDLE_CLOSE'); idle.close(); await noSockets();
    mode = 'tls-stall'; const connecting = create(); const connectingPost = settled(post('MOCK_CONNECT_CLOSE', '/echo', undefined, connecting)); await eventually(() => connects === 4); connecting.close(); assert.deepEqual(await connectingPost, { ok: false, error: 'callback_failed' }); await noSockets();
    mode = 'connect-stall'; const proxyConnecting = create(); const proxyConnectingPost = settled(post('MOCK_PROXY_CLOSE', '/echo', undefined, proxyConnecting)); await eventually(() => connects === 5); proxyConnecting.close(); assert.deepEqual(await proxyConnectingPost, { ok: false, error: 'callback_failed' }); await noSockets();
  } else if (scenario === 'trust-rejection') {
    await expectFailure(post('MOCK_UNTRUSTED'), 'callback_tls_failed'); assert.equal(records.length, 0); assert.equal(connects, 1);
  } else if (scenario === 'sni-hostname-rejection') {
    target.setSecureContext({ key: readFileSync(process.env.MOCK_WRONG_KEY!), cert: readFileSync(process.env.MOCK_WRONG_CERT!) });
    await expectFailure(post('MOCK_WRONG_HOST'), 'callback_tls_failed'); assert.equal(records.length, 0);
  } else if (scenario === 'benchmark') {
    connectDelay = 35; const count = 40;
    const baselinePath = process.env.MOCK_BASELINE!;
    const module = await import(pathToFileURL(baselinePath).href) as { OpenAiManagedProxyCallback: new (env: NodeJS.ProcessEnv) => { post: (url: string, body: string, headers: Record<string, string>) => Promise<{ status: number; body: string }> } };
    async function run(name: string, transport: { post: (url: string, body: string, headers: Record<string, string>) => Promise<{ status: number; body: string }> }) {
      const before = connects, beforeTls = targetConnections, start = performance.now(), samples: number[] = [];
      for (let i = 0; i < count; i++) { const id = `MOCK_BENCH_${name}_${i}`, begin = performance.now(); echo(await transport.post(`${ORIGIN}/echo`, body(id), headers(id)), id); samples.push(performance.now() - begin); }
      const totalMs = performance.now() - start; const sorted = [...samples].sort((a, b) => a - b); return { name, requests: count, connects: connects - before, tlsHandshakes: targetConnections - beforeTls, totalMs: Number(totalMs.toFixed(2)), meanMs: Number((totalMs / count).toFixed(2)), p50Ms: Number(sorted[Math.floor(count * 0.5)]!.toFixed(2)), p95Ms: Number(sorted[Math.floor(count * 0.95)]!.toFixed(2)), samplesMs: samples.map(n => Number(n.toFixed(2))) };
    }
    // Alternating order avoids attributing all process warmup to the same implementation.
    const runs = [];
    runs.push(await run('baseline-1', new module.OpenAiManagedProxyCallback(env)));
    runs.push(await run('pooled-1', candidate)); candidate.close(); await noSockets();
    const second = create(); runs.push(await run('pooled-2', second)); second.close(); await noSockets();
    runs.push(await run('baseline-2', new module.OpenAiManagedProxyCallback(env)));
    for (const run of runs) assert.equal(run.connects, run.name.startsWith('baseline') ? count : 1);
    result.benchmark = { localOnly: true, realWorldPerformanceVerified: false, connectDelayMs: connectDelay, requestsPerRun: count, rounds: 2, concurrency: 1, runs };
  } else assert.fail(`Unknown scenario ${scenario}`);
  assert.deepEqual(errors, []); safeDiagnostics(); assert.ok(serverNames.every(name => name === HOST));
  result.ok = true; result.connects = connects; result.requests = records.length; result.tlsHandshakes = targetConnections; result.maxActive = maxActive; result.sniValidated = serverNames.length > 0; result.diagnosticCount = diagnostics.length;
} finally {
  for (const transport of transports) transport.close();
  // Assert cleanup before destroying fixture sockets, so teardown cannot hide transport leaks.
  await noSockets(); result.socketsBeforeFixtureTeardown = sockets.size;
  for (const timer of timers) clearTimeout(timer);
  await Promise.all([new Promise<void>(resolve => proxy.close(() => resolve())), new Promise<void>(resolve => target.close(() => resolve()))]);
}
console.log(JSON.stringify(result));
