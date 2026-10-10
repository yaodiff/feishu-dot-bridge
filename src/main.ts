import { readFileSync } from 'node:fs';
import { Store } from './store.js';
import { Bridge } from './bridge.js';
import { SecretBox } from './crypto.js';
import { createCallbackTransport } from './callback-runtime.js';
import { LarkSender } from './feishu.js';
import { loadFeishuApps, loadPersonalFeishuApp } from './feishu-config.js';
import { FeishuWebSocketIngress } from './feishu-websocket.js';
import { JwtAuthenticator } from './auth.js';
import { makeApp, nodeServer } from './http.js';
import { loadRuntimeConfig } from './runtime-config.js';
import { readConfiguredSecret } from './private-file.js';
import { createFeishuNetwork } from './feishu-network.js';
import { sanitizeRuntimeDiagnostic } from './runtime-diagnostics.js';
import { BridgeError } from './types.js';
import { mediaInputEnabled } from './media-runtime.js';
import { MediaInputCandidate } from './media-input.js';
import { FeishuMediaTransport } from './feishu-media-transport.js';
import { verifyImageDecoder } from './media-image.js';
process.umask(0o077);
function env(name: string): string { const v = process.env[name]; if (!v) throw new Error(`Missing ${name}`); return v; }
// Reject experimental transport selection before reading credentials or opening data.
const imagesEnabled = mediaInputEnabled(process.env);
const outputImageMode=process.env.FEISHU_IMAGE_OUTPUT ?? 'off';
if(!['off','on'].includes(outputImageMode)) throw new BridgeError('invalid_image_output_configuration');
const outputImagesEnabled=outputImageMode==='on';
if (imagesEnabled || outputImagesEnabled) await verifyImageDecoder();
const diagnostic = (value: unknown) => { const safe = sanitizeRuntimeDiagnostic(value); if (safe) console.log(JSON.stringify(safe)); };
const transport = createCallbackTransport(process.env, hostname => console.warn(JSON.stringify({ event: 'callback_host_not_allowed', hostname })), value => diagnostic({ event: 'callback_transport', ...value }));
const feishuNetwork = createFeishuNetwork(process.env, hostname => console.log(JSON.stringify({ event: 'feishu_ws_host_not_allowed', hostname })));
const runtime = loadRuntimeConfig(process.env);
const definition: unknown = JSON.parse(readFileSync(runtime.appFile, 'utf8'));
const secret = (name: string) => readConfiguredSecret(process.env, name);
const apps = runtime.mode === 'personal-tunnel' ? [loadPersonalFeishuApp(definition, secret)] : loadFeishuApps(definition, secret);
const auth = runtime.personalAuth ?? new JwtAuthenticator(runtime.issuer!, `${runtime.baseUrl}/mcp`, runtime.jwksUrl!);
const personal = runtime.personalAuth ? { owner: runtime.personalAuth.ownerId, appId: apps[0]!.appId, tenantKey: apps[0]!.tenantKey } : undefined;
const store = new Store(runtime.databasePath, personal);
const sender = new LarkSender(apps, feishuNetwork);
const bridge = new Bridge(store, new SecretBox(Buffer.from(readConfiguredSecret(process.env, 'STORAGE_KEY'), 'base64')), transport, sender, Date.now, personal, diagnostic, {images:outputImagesEnabled});
const mediaTransport = imagesEnabled ? new FeishuMediaTransport(apps, appId => sender.mediaAccessToken(appId), process.env) : undefined;
const media = mediaTransport ? new MediaInputCandidate(bridge, mediaTransport, (_principal, _eventId, kind) => kind === 'image') : undefined;
const app = makeApp({ authMode: runtime.mode, publicUrl: runtime.baseUrl, issuer: runtime.issuer, apps, allowedOrigins: (process.env.ALLOWED_ORIGINS ?? 'https://chatgpt.com').split(',') }, bridge, auth, media);
const server = nodeServer(app, runtime.baseUrl, runtime.allowedHosts);
const wsIngress = new FeishuWebSocketIngress(apps, message => media ? media.receiveAuthenticated(message) : bridge.receive(message), {
  mediaEnabled: imagesEnabled,
  network: feishuNetwork,
  notice: event => { console.log(JSON.stringify({ event })); diagnostic({ event: 'bridge_ws_lifecycle', state: event }); },
  onTerminalFailure: () => { console.error('{"event":"bridge_ingress_terminal_failure"}'); process.exitCode = 1; void shutdown(); }
});
let timer: NodeJS.Timeout | undefined;
let closing: Promise<void> | undefined;
function shutdown(): Promise<void> {
  if (closing) return closing;
  closing = (async () => { clearInterval(timer); wsIngress.stop(); media?.close(); mediaTransport?.close(); feishuNetwork?.close(); await new Promise<void>(resolve => server.close(() => resolve())); await bridge.waitForIdle(); transport.close?.(); store.close(); })();
  return closing;
}
process.on('SIGTERM', () => { void shutdown(); }); process.on('SIGINT', () => { void shutdown(); });
try {
  await wsIngress.start();
  if (!closing) {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(runtime.port, runtime.host, resolve); });
    if (!closing) {
      console.log(JSON.stringify({ event: 'bridge_started', port: runtime.port, mode: runtime.mode, version: '0.1.0' }));
      timer = setInterval(() => { void bridge.pump().catch(() => console.error('{"event":"worker_failed"}')); }, 1000);
    }
  }
} catch (error) {
  const reason = error instanceof BridgeError && ['ws_start_timeout', 'ws_start_failed', 'duplicate_ws_consumer', 'invalid_ws_configuration', 'ws_ingress_stopped'].includes(error.code) ? error.code : 'other';
  diagnostic({ event: 'bridge_start_failure', reason });
  console.error('{"event":"bridge_start_failed"}'); await shutdown(); process.exitCode = 1;
}
