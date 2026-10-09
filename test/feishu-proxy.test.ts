import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as httpsServer } from 'node:https';
import { createServer as httpServer } from 'node:http';
import { connect } from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import type { Duplex } from 'node:stream';
import type { TLSSocket } from 'node:tls';
import { createFeishuNetwork } from '../src/feishu-network.js';

const API = 'https://open.feishu.cn';
const proxyEnvironment = { FEISHU_TRANSPORT: 'managed-proxy', CODEX_NETWORK_PROXY_ACTIVE: '1', HTTPS_PROXY: 'http://127.0.0.1:12345' };

test('Feishu managed transport is explicit, validates proxy metadata, and has bounded Axios defaults', () => {
  assert.equal(createFeishuNetwork({}), undefined);
  assert.equal(createFeishuNetwork({ FEISHU_TRANSPORT: 'default' }), undefined);
  assert.throws(() => createFeishuNetwork({ FEISHU_TRANSPORT: 'unknown' }));
  for (const environment of [
    { FEISHU_TRANSPORT: 'managed-proxy' },
    { ...proxyEnvironment, CODEX_NETWORK_PROXY_ACTIVE: '0' },
    { ...proxyEnvironment, HTTPS_PROXY: 'http://remote.invalid:12345' },
    { ...proxyEnvironment, HTTPS_PROXY: 'http://user:password@127.0.0.1:12345' },
    { ...proxyEnvironment, https_proxy: 'http://127.0.0.1:12346' }
  ]) assert.throws(() => createFeishuNetwork(environment));
  const network = createFeishuNetwork({ ...proxyEnvironment, NO_PROXY: '*' })!;
  try {
    assert.equal(network.startupTimeoutMs, 35000);
    assert.equal(network.http.defaults.proxy, false);
    assert.equal(network.http.defaults.maxRedirects, 0);
    assert.equal(network.http.defaults.timeout, 15000);
    assert.equal(network.http.defaults.maxBodyLength, 262144);
    assert.equal(network.http.defaults.maxContentLength, 262144);
  } finally { network.close(); }
});

type ProxyMode = 'normal' | 'delayed' | 'delayed-tls-stall' | 'reject' | 'stall' | 'trickle' | 'tls-stall' | 'tls-trickle';
type WorkerResult = { ok: boolean; error?: string; code?: string; status?: number; data?: unknown; bodyBytes?: number; rejected?: boolean; count?: number; closed?: boolean; ready?: boolean; state?: string; blockedHosts?: string[] };

test('Feishu HTTP and SDK-style WebSocket upgrades use local CONNECT with verified TLS and bounded cleanup', { timeout: 145000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'MOCK-feishu-proxy-'));
  const key = join(directory, 'key.pem'), certificate = join(directory, 'cert.pem');
  const wrongKey = join(directory, 'wrong-key.pem'), wrongCertificate = join(directory, 'wrong-cert.pem');
  for (const [keyPath, certificatePath, names] of [
    [key, certificate, ['open.feishu.cn', 'open.larksuite.com', 'msg-frontier.feishu.cn', 'msg-frontier.larksuite.com']],
    [wrongKey, wrongCertificate, ['wrong.invalid']]
  ] as const) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certificatePath,
      '-subj', '/CN=' + names[0], '-addext', 'subjectAltName=' + names.map(name => 'DNS:' + name).join(','), '-days', '1'], { stdio: 'ignore' });
    chmodSync(keyPath, 0o600);
  }
  let requests = 0, upgrades = 0, endpointDiscoveries = 0;
  let mode: ProxyMode = 'normal';
  let discoveredUrl: string | undefined;
  const authorities: string[] = [], serverNames: string[] = [];
  const sockets = new Set<Duplex>();
  const timers = new Set<NodeJS.Timeout>();
  const track = (socket: Duplex) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  };
  const target = httpsServer({ key: readFileSync(key), cert: readFileSync(certificate) }, async (request, response) => {
    requests++;
    const chunks: Buffer[] = [];
    try { for await (const chunk of request) chunks.push(Buffer.from(chunk)); } catch { return; }
    const body = Buffer.concat(chunks);
    if (request.url === '/callback/ws/endpoint') {
      endpointDiscoveries++;
      assert.deepEqual(JSON.parse(body.toString()), { AppID: 'cli_0123456789abcdef', AppSecret: 'MOCK_NOT_A_CREDENTIAL' });
      const suffix = request.headers.host?.includes('larksuite.com') ? 'larksuite.com' : 'feishu.cn';
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: 0, data: {
        URL: discoveredUrl ?? 'wss://msg-frontier.' + suffix + '/socket?device_id=1&service_id=1',
        ClientConfig: { PingInterval: 60, ReconnectCount: 1, ReconnectInterval: 1, ReconnectNonce: 0 }
      } }));
    } else if (request.url === '/redirect') {
      response.writeHead(302, { location: API + '/redirect-followed' });
      response.end();
    } else if (request.url === '/boundary' || request.url === '/oversized') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end('x'.repeat(request.url === '/boundary' ? 262144 : 262145));
    } else if (request.url === '/hang') {
      // The client's absolute request deadline must close this open response.
    } else if (request.url === '/body-trickle') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.write('x');
      const timer = setInterval(() => { if (response.destroyed) { clearInterval(timer); timers.delete(timer); } else response.write('x'); }, 100);
      timers.add(timer);
    } else if (request.url === '/echo-size') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ bytes: body.length }));
    } else {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: 0, data: { marker: 'MOCK_FEISHU_RESPONSE' } }));
    }
  });
  target.on('connection', track);
  target.on('secureConnection', socket => serverNames.push((socket as TLSSocket).servername || ''));
  target.on('upgrade', (request, socket) => {
    upgrades++;
    socket.resume(); // Consume SDK ping frames so peer EOF is observed without a full WS server.
    socket.on('error', () => socket.destroy());
    socket.on('end', () => socket.end());
    if (request.url === '/pending-upgrade') return;
    const accept = request.headers['sec-websocket-key']
      ? 'Sec-WebSocket-Accept: ' + createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64') + '\r\n'
      : '';
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' + accept + '\r\n');
  });
  await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
  const tlsPort = (target.address() as { port: number }).port;
  const proxy = httpServer();
  proxy.on('connect', (request, socket, head) => {
    authorities.push(request.url ?? '');
    assert.equal(request.headers['proxy-authorization'], undefined);
    track(socket);
    socket.on('end', () => socket.end());
    if (mode === 'reject') {
      socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (mode === 'stall') { socket.resume(); return; }
    if (mode === 'trickle') {
      socket.resume();
      socket.write('HTTP/1.1 200 Connection Established\r\nX-Mock: ');
      const timer = setInterval(() => { if (socket.destroyed) { clearInterval(timer); timers.delete(timer); } else socket.write('x'); }, 100);
      timers.add(timer);
      return;
    }
    if (mode === 'delayed-tls-stall') {
      socket.resume();
      timers.add(setTimeout(() => { if (!socket.destroyed) socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); }, 11000));
      return;
    }
    if (mode === 'tls-stall' || mode === 'tls-trickle') {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      socket.resume();
      // Wait for ClientHello: early TLS bytes may otherwise become CONNECT head.
      if (mode === 'tls-trickle') socket.once('data', () => {
        socket.write(Buffer.from([0x16, 0x03, 0x03, 0x03, 0xe8, 0x02]));
        const timer = setInterval(() => { if (socket.destroyed) { clearInterval(timer); timers.delete(timer); } else socket.write(Buffer.from([0])); }, 100);
        timers.add(timer);
      });
      return;
    }
    const establish = () => {
    if (socket.destroyed) return;
    const upstream = connect(tlsPort, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    track(upstream);
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    upstream.once('close', () => socket.destroy());
    socket.once('close', () => upstream.destroy());
    };
    if (mode === 'delayed') timers.add(setTimeout(establish, 11000)); else establish();
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const proxyPort = (proxy.address() as { port: number }).port;

  async function worker(command = 'get', url = API + '/success', trust: string | false = certificate, limitMs = 18000): Promise<WorkerResult> {
    const child = spawn(process.execPath, [resolve('dist/test/feishu-proxy-worker.js'), command, url], {
      env: { PATH: process.env.PATH, FEISHU_TRANSPORT: 'managed-proxy', CODEX_NETWORK_PROXY_ACTIVE: '1',
        HTTPS_PROXY: 'http://127.0.0.1:' + proxyPort, NO_PROXY: '*', ...(trust ? { NODE_EXTRA_CA_CERTS: trust } : {}) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '', errors = '', killed = false;
    child.stdout.on('data', chunk => output += chunk.toString());
    child.stderr.on('data', chunk => errors += chunk.toString());
    const watchdog = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, limitMs);
    let code: unknown;
    try { [code] = await once(child, 'exit'); } finally { clearTimeout(watchdog); }
    assert.equal(killed, false, 'Worker must exit naturally; output=' + output + '; stderr=' + errors);
    assert.equal(code, 0, 'Worker failed: ' + errors);
    for (let i = 0; sockets.size && i < 20; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(sockets.size, 0, 'No sockets may survive worker exit, before fixture teardown');
    assert.ok(output.trim(), 'Worker must settle its operation and report a result');
    return JSON.parse(output.trim()) as WorkerResult;
  }
  const rejects = (result: WorkerResult, context: string) => assert.equal(result.ok, false, context + ': ' + JSON.stringify(result));

  try {
    await t.test('both Feishu APIs return unwrapped Axios data through CONNECT even with NO_PROXY=*', async () => {
      for (const host of ['open.feishu.cn', 'open.larksuite.com']) {
        const before = authorities.length;
        assert.deepEqual(await worker('get', 'https://' + host + '/success'), { ok: true, data: { code: 0, data: { marker: 'MOCK_FEISHU_RESPONSE' } } });
        assert.deepEqual(authorities.slice(before), [host + ':443']);
        assert.ok(serverNames.includes(host), 'TLS SNI must be the origin host');
      }
    });
    await t.test('SDK-style HTTPS Upgrade supports only the two approved Feishu and Lark endpoint hosts', async () => {
      for (const host of ['msg-frontier.feishu.cn', 'msg-frontier.larksuite.com']) {
        const before = authorities.length;
        assert.deepEqual(await worker('upgrade', 'https://' + host + '/socket'), { ok: true, status: 101 });
        assert.deepEqual(authorities.slice(before), [host + ':443']);
        assert.ok(serverNames.includes(host));
      }
      assert.equal(upgrades, 2);
      assert.deepEqual(await worker('close-open-upgrade', 'https://msg-frontier.feishu.cn/socket', certificate, 3000), { ok: true, closed: true });
    });
    await t.test('production SDK ingress discovers its endpoint, upgrades through the agent, and reports readiness', async () => {
      for (const suffix of ['feishu.cn', 'larksuite.com']) {
        const before = authorities.length;
        const result = await worker('sdk-ingress', 'https://open.' + suffix + '/success', certificate, 5000);
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.ready, true);
        assert.equal(result.state, 'connected');
        assert.deepEqual(authorities.slice(before), ['open.' + suffix + ':443', 'msg-frontier.' + suffix + ':443']);
        assert.ok(serverNames.includes('msg-frontier.' + suffix));
      }
      assert.equal(endpointDiscoveries, 2);
    });
    await t.test('endpoint discovery fails closed for arbitrary, regional, trailing-dot, mismatched, or malformed WS URLs', async () => {
      const invalid = [
        'wss://ws.feishu.cn/socket', 'wss://msg-frontier-eu.feishu.cn/socket',
        'wss://msg-frontier.feishu.cn./socket', 'wss://msg-frontier.larksuite.com/socket',
        'wss://user:password@msg-frontier.feishu.cn/socket', 'wss://msg-frontier.feishu.cn:444/socket',
        'wss://msg-frontier.feishu.cn/socket#fragment', 'ws://msg-frontier.feishu.cn/socket',
        'wss://127.0.0.1/socket', 'wss://msg-frontier.feishu.cn.evil.invalid/socket',
        'wss://msg-frontier.feishu.cn/socket\n', 'wss://msg-frontier.feishu.cn/' + 'x'.repeat(4096)
      ];
      const before = upgrades;
      try {
        for (const url of invalid) {
          discoveredUrl = url;
          const result = await worker('discover', API + '/callback/ws/endpoint');
          rejects(result, url);
        }
        discoveredUrl = 'wss://msg-frontier.feishu.cn/socket';
        rejects(await worker('discover', 'https://open.larksuite.com/callback/ws/endpoint'), 'cross-vendor Lark discovery');
        discoveredUrl = 'wss://msg-frontier-eu.feishu.cn/socket?ticket=MOCK_CAPABILITY&secret=MOCK_SECRET';
        const blocked = await worker('discover', API + '/callback/ws/endpoint');
        rejects(blocked, 'unreviewed endpoint');
        assert.deepEqual(blocked.blockedHosts, ['msg-frontier-eu.feishu.cn']);
        assert.doesNotMatch(JSON.stringify(blocked), /MOCK_CAPABILITY|MOCK_SECRET|ticket=|secret=/);
        discoveredUrl = 'wss://msg-frontier.feishu.cn:443/socket?device_id=1&service_id=1';
        assert.equal((await worker('discover', API + '/callback/ws/endpoint')).ok, true, 'Explicit standard WSS port remains permitted');
      } finally { discoveredUrl = undefined; }
      assert.equal(upgrades, before, 'Rejected discovery URLs may never initiate an Upgrade');
    });
    await t.test('unsafe API and WebSocket destinations reject before any CONNECT', async () => {
      const before = authorities.length;
      assert.deepEqual(await worker('invalid-http'), { ok: true, rejected: true, count: 8 });
      assert.deepEqual(await worker('invalid-ws'), { ok: true, rejected: true, count: 10 });
      assert.equal(authorities.length, before);
    });
    await t.test('HTTP 302 is returned as a failure without following Location', async () => {
      const before = requests;
      const result = await worker('get', API + '/redirect');
      rejects(result, 'redirect');
      assert.equal(result.status, 302);
      assert.equal(requests, before + 1);
    });
    await t.test('request-level Axios overrides cannot bypass the managed proxy, redirects, byte limits, or TLS verification', async () => {
      const before = authorities.length;
      assert.deepEqual(await worker('override-get'), { ok: true, data: { code: 0, data: { marker: 'MOCK_FEISHU_RESPONSE' } } });
      assert.deepEqual(authorities.slice(before), ['open.feishu.cn:443']);
      const requestsBeforeRedirect = requests;
      const redirect = await worker('override-get', API + '/redirect');
      rejects(redirect, 'override redirect');
      assert.equal(redirect.status, 302);
      assert.equal(requests, requestsBeforeRedirect + 1);
      rejects(await worker('override-get', API + '/oversized'), 'override response limit');
      rejects(await worker('override-get', API + '/success', false), 'override insecure TLS');
    });
    await t.test('256 KiB request and response limits use bytes and allow the exact boundary', async () => {
      assert.deepEqual(await worker('get', API + '/boundary'), { ok: true, bodyBytes: 262144 });
      rejects(await worker('get', API + '/oversized'), 'oversized response');
      assert.deepEqual(await worker('post-boundary', API + '/echo-size'), { ok: true, data: { bytes: 262144 } });
      const before = requests;
      rejects(await worker('post-overflow', API + '/echo-size'), 'oversized request');
      rejects(await worker('post-multibyte-overflow', API + '/echo-size'), 'oversized multibyte request');
      assert.equal(requests, before, 'Oversized request bodies must not reach the origin');
    });
    await t.test('untrusted and wrong-host certificates fail for HTTP and WebSocket', async () => {
      for (const command of ['get', 'upgrade']) {
        const url = command === 'get' ? API + '/success' : 'https://msg-frontier.feishu.cn/socket';
        rejects(await worker(command, url, false), command + ' untrusted certificate');
      }
      target.setSecureContext({ key: readFileSync(wrongKey), cert: readFileSync(wrongCertificate) });
      try {
        for (const command of ['get', 'upgrade']) {
          const url = command === 'get' ? API + '/success' : 'https://msg-frontier.feishu.cn/socket';
          rejects(await worker(command, url, wrongCertificate), command + ' wrong-host certificate');
        }
      } finally { target.setSecureContext({ key: readFileSync(key), cert: readFileSync(certificate) }); }
    });
    await t.test('CONNECT rejection never falls back to a direct connection', async () => {
      mode = 'reject';
      const before = requests;
      rejects(await worker(), 'CONNECT rejection');
      assert.equal(requests, before);
      mode = 'normal';
    });
    await t.test('close aborts concurrent pending HTTP and WebSocket connections promptly', async () => {
      for (const pendingMode of ['stall', 'tls-stall', 'normal'] as const) {
        mode = pendingMode;
        assert.deepEqual(await worker('close-pending', API + '/hang', certificate, 3000), { ok: true, rejected: true });
      }
      mode = 'normal';
      const before = authorities.length;
      assert.deepEqual(await worker('close-idempotent', API + '/success', certificate, 3000), { ok: true, rejected: true });
      assert.equal(authorities.length, before, 'A closed network cannot open new proxy tunnels');
    });
    await t.test('HTTP and WebSocket CONNECT completing after 11s fit inside the fixed 15s total budget', async () => {
      mode = 'delayed';
      for (const command of ['get', 'upgrade']) {
        const started = Date.now();
        const result = await worker(command, command === 'get' ? API + '/success' : 'https://msg-frontier.feishu.cn/socket');
        assert.equal(result.ok, true, JSON.stringify(result));
        const elapsed = Date.now() - started;
        assert.ok(elapsed >= 10900 && elapsed < 15000, command + ' delayed CONNECT: ' + elapsed);
      }
      mode = 'normal';
    });
    await t.test('absolute CONNECT deadlines survive stalled and trickling proxy headers', async () => {
      for (const pendingMode of ['stall', 'trickle'] as const) {
        mode = pendingMode;
        const started = Date.now();
        rejects(await worker(), pendingMode);
        const elapsed = Date.now() - started;
        assert.ok(elapsed >= 11900 && elapsed < 14500, pendingMode + ' CONNECT exceeded its absolute 12s deadline: ' + elapsed);
        t.diagnostic(pendingMode + ': ' + elapsed + 'ms; natural child exit; zero remaining sockets');
      }
      mode = 'normal';
    });
    await t.test('absolute TLS deadlines survive stalled and trickling handshakes for WebSocket', async () => {
      for (const pendingMode of ['delayed-tls-stall', 'tls-trickle'] as const) {
        mode = pendingMode;
        const started = Date.now();
        rejects(await worker('upgrade', 'https://msg-frontier.feishu.cn/socket'), pendingMode);
        const elapsed = Date.now() - started;
        assert.ok(elapsed >= 14900 && elapsed < 18000, pendingMode + ' TLS exceeded its absolute 15s deadline: ' + elapsed);
        t.diagnostic(pendingMode + ': ' + elapsed + 'ms; natural child exit; zero remaining sockets');
      }
      mode = 'normal';
    });
    await t.test('absolute HTTP deadline survives open and continuously trickling responses', async () => {
      for (const path of ['/hang', '/body-trickle']) {
        mode = path === '/hang' ? 'delayed' : 'normal';
        const started = Date.now();
        rejects(await worker('get', API + path), path);
        const elapsed = Date.now() - started;
        assert.ok(elapsed >= 14900 && elapsed < 18000, path + ' exceeded its absolute 15s deadline: ' + elapsed);
        t.diagnostic(path + ': ' + elapsed + 'ms; natural child exit; zero remaining sockets');
      }
    });
  } finally {
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await Promise.all([new Promise<void>(resolve => proxy.close(() => resolve())), new Promise<void>(resolve => target.close(() => resolve()))]);
    rmSync(directory, { recursive: true, force: true });
  }
});
