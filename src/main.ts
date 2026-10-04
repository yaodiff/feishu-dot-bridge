import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { Store } from './store.js';
import { Bridge } from './bridge.js';
import { SecretBox } from './crypto.js';
import { PublicHttpsCallback } from './callback.js';
import { LarkSender } from './feishu.js';
import { loadFeishuApps } from './feishu-config.js';
import { FeishuWebSocketIngress } from './feishu-websocket.js';
import { JwtAuthenticator } from './auth.js';
import { makeApp, nodeServer } from './http.js';
process.umask(0o077);
function env(name: string): string { const v = process.env[name]; if (!v) throw new Error(`Missing ${name}`); return v; }
const httpsUrl = z.string().url().refine(v => { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password && !u.hash && !u.search; });
const publicUrl = httpsUrl.parse(env('PUBLIC_URL')).replace(/\/$/, '');
if (new URL(publicUrl).pathname !== '/') throw new Error('PUBLIC_URL must be an HTTPS origin, with no path');
const issuer = httpsUrl.parse(env('OAUTH_ISSUER'));
const apps = loadFeishuApps(JSON.parse(readFileSync(process.env.FEISHU_APPS_FILE ?? './config/feishu-apps.json', 'utf8')), env);
const store = new Store(process.env.DATABASE_PATH ?? './data/bridge.sqlite');
const transport = new PublicHttpsCallback(env('CALLBACK_HOSTS').split(',').map(s => s.trim()).filter(Boolean), hostname => console.warn(JSON.stringify({ event: 'callback_host_not_allowed', hostname })));
const bridge = new Bridge(store, new SecretBox(Buffer.from(env('STORAGE_KEY'), 'base64')), transport, new LarkSender(apps));
const auth = new JwtAuthenticator(issuer, `${publicUrl}/mcp`, new URL(httpsUrl.parse(env('OAUTH_JWKS_URL'))));
const app = makeApp({ publicUrl, issuer, apps, allowedOrigins: (process.env.ALLOWED_ORIGINS ?? 'https://chatgpt.com').split(',') }, bridge, auth);
const server = nodeServer(app, publicUrl, (process.env.ALLOWED_HOSTS ?? new URL(publicUrl).host).split(','));
const port = Number(process.env.PORT ?? '3000');
const wsIngress = new FeishuWebSocketIngress(apps, message => bridge.receive(message), {
  notice: event => console.log(JSON.stringify({ event })),
  onTerminalFailure: () => { console.error('{"event":"bridge_ingress_terminal_failure"}'); process.exitCode = 1; void shutdown(); }
});
let timer: NodeJS.Timeout | undefined;
let closing: Promise<void> | undefined;
function shutdown(): Promise<void> {
  if (closing) return closing;
  closing = (async () => { clearInterval(timer); wsIngress.stop(); await new Promise<void>(resolve => server.close(() => resolve())); await bridge.waitForIdle(); store.close(); })();
  return closing;
}
process.on('SIGTERM', () => { void shutdown(); }); process.on('SIGINT', () => { void shutdown(); });
try {
  await wsIngress.start();
  if (!closing) {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, process.env.HOST ?? '127.0.0.1', resolve); });
    if (!closing) {
      console.log(JSON.stringify({ event: 'bridge_started', port, version: '0.1.0' }));
      timer = setInterval(() => { void bridge.pump().catch(() => console.error('{"event":"worker_failed"}')); }, 1000);
    }
  }
} catch {
  console.error('{"event":"bridge_start_failed"}'); await shutdown(); process.exitCode = 1;
}
