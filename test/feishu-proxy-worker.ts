/** Synthetic transport exercise only: no real Feishu credentials or remote services. */
import { Agent, request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';
import { createFeishuNetwork } from '../src/feishu-network.js';

const mode = process.argv[2] ?? 'get';
const target = process.argv[3] ?? 'https://open.feishu.cn/success';
const blockedHosts: string[] = [];
const network = createFeishuNetwork(process.env, host => blockedHosts.push(host));
if (!network) throw new Error('managed_transport_not_selected');

function upgrade(url: string, leaveOpen = false): Promise<{ status: number; socket?: Duplex }> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, {
      agent: network!.wsAgent,
      headers: { connection: 'Upgrade', upgrade: 'websocket' }
    });
    request.once('error', reject);
    request.once('response', response => {
      response.resume();
      reject(new Error('expected_upgrade_' + response.statusCode));
    });
    request.once('upgrade', (response, socket) => {
      socket.on('error', () => {});
      if (!leaveOpen) socket.destroy();
      resolve({ status: response.statusCode ?? 0, ...(leaveOpen ? { socket } : {}) });
    });
    request.end();
  });
}

try {
  if (mode === 'sdk-ingress') {
    const { FeishuWebSocketIngress } = await import('../src/feishu-websocket.js');
    const notices: string[] = [];
    const ingress = new FeishuWebSocketIngress([{
      appId: 'cli_0123456789abcdef', appSecret: 'MOCK_NOT_A_CREDENTIAL', tenantKey: 'MOCK_TENANT',
      domain: target.includes('larksuite.com') ? 'lark' : 'feishu', ingress: 'websocket',
      websocketExclusiveConsumer: true, encryptKey: '', verificationToken: ''
    }], () => {}, { network, notice: notice => notices.push(notice) });
    try {
      await ingress.start();
      console.log(JSON.stringify({ ok: true, ready: notices.includes('ws_ready'), state: ingress.status()[0]?.state }));
    } finally { ingress.stop(); network.close(); }
  } else if (mode === 'upgrade') {
    const result = await upgrade(target);
    console.log(JSON.stringify({ ok: true, status: result.status }));
  } else if (mode === 'close-open-upgrade') {
    const { socket } = await upgrade(target, true);
    const closed = new Promise<void>(resolve => socket!.once('close', () => resolve()));
    network.close();
    await closed;
    console.log(JSON.stringify({ ok: true, closed: true }));
  } else if (mode === 'close-pending') {
    const pending = [network.http.get(target), upgrade('https://msg-frontier.feishu.cn/pending-upgrade')];
    const closeTimer = setTimeout(() => network.close(), 250);
    const results = await Promise.allSettled(pending);
    clearTimeout(closeTimer);
    console.log(JSON.stringify({ ok: true, rejected: results.every(result => result.status === 'rejected') }));
  } else if (mode === 'close-idempotent') {
    network.close();
    network.close();
    const results = await Promise.allSettled([network.http.get(target), upgrade('https://msg-frontier.feishu.cn/socket')]);
    console.log(JSON.stringify({ ok: true, rejected: results.every(result => result.status === 'rejected') }));
  } else if (mode === 'discover') {
    const data = await network.http.post(target, { AppID: 'cli_0123456789abcdef', AppSecret: 'MOCK_NOT_A_CREDENTIAL' });
    console.log(JSON.stringify({ ok: true, data }));
  } else if (mode === 'post-boundary' || mode === 'post-overflow' || mode === 'post-multibyte-overflow') {
    const body = mode === 'post-multibyte-overflow' ? '界'.repeat(87382) : 'x'.repeat(mode === 'post-boundary' ? 262144 : 262145);
    const data = await network.http.post(target, body, { headers: { 'content-type': 'application/octet-stream' } });
    console.log(JSON.stringify({ ok: true, data }));
  } else if (mode === 'invalid-http') {
    const invalid = [
      'http://open.feishu.cn/success', 'https://open.feishu.cn:444/success',
      'https://127.0.0.1/success', 'https://[::1]/success',
      'https://open.feishu.cn.evil.invalid/success', 'https://msg-frontier.feishu.cn/success',
      'https://evil.invalid/success', 'https://user:password@open.feishu.cn/success'
    ];
    const results = await Promise.allSettled(invalid.map(url => network.http.get(url)));
    console.log(JSON.stringify({ ok: true, rejected: results.every(result => result.status === 'rejected'), count: results.length }));
  } else if (mode === 'invalid-ws') {
    const invalid = [
      'https://127.0.0.1/socket', 'https://[::1]/socket',
      'https://msg-frontier.feishu.cn:444/socket', 'https://feishu.cn.evil.invalid/socket',
      'https://evil.invalid/socket', 'https://ws.feishu.cn/socket',
      'https://msg-frontier-eu.feishu.cn/socket', 'https://msg-frontier.feishu.cn./socket',
      'https://feishu.cn/socket', 'https://ws.larksuite.com/socket'
    ];
    const results = await Promise.allSettled(invalid.map(url => upgrade(url)));
    console.log(JSON.stringify({ ok: true, rejected: results.every(result => result.status === 'rejected'), count: results.length }));
  } else {
    const overrides = mode === 'override-get' ? {
      proxy: { host: '127.0.0.1', port: 1, protocol: 'http' },
      httpsAgent: new Agent({ rejectUnauthorized: false }),
      timeout: 0, maxRedirects: 5, maxBodyLength: Infinity, maxContentLength: Infinity,
      responseType: 'stream' as const, validateStatus: () => true,
      adapter: async () => { throw new Error('caller_adapter_must_not_run'); }
    } : undefined;
    const data = await network.http.get(target, overrides);
    console.log(JSON.stringify(typeof data === 'string' ? { ok: true, bodyBytes: Buffer.byteLength(data) } : { ok: true, data }));
  }
} catch (error) {
  const failure = error as Error & { code?: string; response?: { status?: number } };
  console.log(JSON.stringify({ ok: false, error: failure.message, code: failure.code, status: failure.response?.status, ...(mode === 'discover' ? { blockedHosts } : {}) }));
}
