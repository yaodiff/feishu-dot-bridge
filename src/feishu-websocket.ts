import * as lark from '@larksuiteoapi/node-sdk';
import { createLarkHttp, decodeFeishuWebSocket, silentLarkLogger } from './feishu.js';
import { BridgeError, type FeishuApp, type Inbound } from './types.js';

export interface WebSocketClient {
  start(options: { eventDispatcher: lark.EventDispatcher }): Promise<void>;
  close(options?: { force?: boolean }): void;
  getConnectionStatus(): { state: string };
}
export interface WebSocketHooks { ready(): void; failed(): void; reconnecting(): void; reconnected(): void }
export type WebSocketFactory = (app: FeishuApp, hooks: WebSocketHooks) => WebSocketClient;
export type WebSocketNotice = 'ws_connecting' | 'ws_ready' | 'ws_reconnecting' | 'ws_reconnected' | 'ws_failed' | 'ws_event_rejected' | 'ws_storage_failed';
const activeApps = new Set<string>(); // In-process only; never claims to detect other hosts/processes.
const appKey = (app: FeishuApp) => app.appId;

/** For integration into an existing official SDK dispatcher. The owner of that
 * dispatcher MUST authenticate the app's connection and preserve other handlers.
 * This is not a network endpoint and does not authenticate arbitrary JSON. */
export function authenticatedWebSocketMessageHandler(app: FeishuApp, receive: (message: Inbound) => unknown, options: { active?: () => boolean; notice?: (event: WebSocketNotice) => void } = {}) {
  const notice = (event: WebSocketNotice) => { try { options.notice?.(event); } catch { /* Instrumentation must not change acknowledgement semantics. */ } };
  return async (data: unknown): Promise<void> => {
    if (options.active && !options.active()) return;
    let result;
    try { result = decodeFeishuWebSocket(app, data); }
    catch { notice('ws_event_rejected'); return; }
    if ('message' in result) {
      try { await receive(result.message); } // Persist + enqueue only; never wait for an outbound API here.
      catch { notice('ws_storage_failed'); throw new BridgeError('ws_storage_failed', 503); }
    }
  };
}
const productionFactory: WebSocketFactory = (app, hooks) => new lark.WSClient({
  appId: app.appId, appSecret: app.appSecret, domain: app.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
  httpInstance: createLarkHttp(), logger: silentLarkLogger, autoReconnect: true, handshakeTimeoutMs: 10000,
  wsConfig: { pingTimeout: 30 }, onReady: hooks.ready, onError: () => hooks.failed(),
  onReconnecting: hooks.reconnecting, onReconnected: hooks.reconnected
});
type Entry = { app: FeishuApp; client?: WebSocketClient; reject: (error: Error) => void; ready: boolean; timer?: NodeJS.Timeout };

/** One SDK client per configured WS app. SDK owns reconnects; no second reconnect
 * worker is spawned. Do not run alongside another consumer for the same app. */
export class FeishuWebSocketIngress {
  private entries: Entry[] = [];
  private startup?: Promise<void>;
  private stopped = false;
  private started = false;
  private startupFailed = false;
  private rejectStartup?: (error: Error) => void;
  constructor(private apps: FeishuApp[], private receive: (message: Inbound) => unknown, private options: { factory?: WebSocketFactory; notice?: (event: WebSocketNotice) => void; startupTimeoutMs?: number; onTerminalFailure?: () => void } = {}) {}
  private notify(event: WebSocketNotice): void { try { this.options.notice?.(event); } catch { /* Logs cannot alter lifecycle cleanup. */ } }
  start(): Promise<void> {
    if (this.stopped) return Promise.reject(new BridgeError('ws_ingress_stopped'));
    if (this.startup) return this.startup;
    // Defer work so concurrent start() calls share the same startup promise.
    this.startup = Promise.resolve().then(() => this.startOnce()).catch(error => { this.stop(); throw error; });
    return this.startup;
  }
  private async startOnce(): Promise<void> {
    if (this.stopped) throw new BridgeError('ws_ingress_stopped');
    const selected = this.apps.filter(app => app.ingress === 'websocket');
    const keys = selected.map(appKey);
    if (new Set(keys).size !== keys.length || keys.some(key => activeApps.has(key))) throw new BridgeError('duplicate_ws_consumer');
    if (selected.some(app => app.websocketExclusiveConsumer !== true || !/^cli_[0-9a-fA-F]{16}$/.test(app.appId) || !app.tenantKey || !app.appSecret)) throw new BridgeError('invalid_ws_configuration');
    for (const key of keys) activeApps.add(key);
    // Reserve all entries before any factory can throw, allowing complete rollback.
    this.entries = selected.map(app => ({ app, reject: () => {}, ready: false }));
    const terminalDuringStartup = new Promise<never>((_resolve, reject) => { this.rejectStartup = reject; });
    const allReady = Promise.all(this.entries.map(entry => new Promise<void>((resolve, reject) => {
      entry.reject = reject;
      const notice = (event: WebSocketNotice) => this.notify(event);
      const fail = () => {
        if (this.stopped) return;
        notice('ws_failed'); entry.ready = false;
        if (!this.started) {
          this.startupFailed = true;
          const error = new BridgeError('ws_start_failed');
          // Reject the aggregate even if THIS entry's readiness promise already resolved.
          this.rejectStartup?.(error); reject(error);
        } else {
          // SDK onError is terminal (retry loop ended), not an ordinary reconnect notice.
          // Close every ingress and notify the host to stop serving/restart explicitly.
          this.stop();
          try { this.options.onTerminalFailure?.(); } catch { /* Cleanup already completed. */ }
        }
      };
      const hooks: WebSocketHooks = {
        ready: () => { if (this.stopped || this.startupFailed) return; entry.ready = true; clearTimeout(entry.timer); notice('ws_ready'); resolve(); },
        failed: fail,
        reconnecting: () => { if (!this.stopped) notice('ws_reconnecting'); },
        reconnected: () => { if (!this.stopped && !this.startupFailed) { entry.ready = true; notice('ws_reconnected'); } }
      };
      const factory = this.options.factory ?? productionFactory;
      try {
        entry.client = factory(entry.app, hooks);
        const dispatcher = new lark.EventDispatcher({ logger: silentLarkLogger }).register({
          'im.message.receive_v1': authenticatedWebSocketMessageHandler(entry.app, this.receive, { active: () => !this.stopped && entry.ready, notice })
        });
        entry.timer = setTimeout(() => reject(new BridgeError('ws_start_timeout')), this.options.startupTimeoutMs ?? 15000);
        notice('ws_connecting');
        // SDK start() returns before authentication/handshake readiness. Only onReady resolves us.
        void entry.client.start({ eventDispatcher: dispatcher }).catch(fail);
      } catch { fail(); }
    })));
    await Promise.race([allReady, terminalDuringStartup]);
    // A ready entry may fail while another app is still connecting. Do not publish readiness.
    if (this.stopped || this.startupFailed || this.entries.some(entry => !entry.ready)) throw new BridgeError('ws_start_failed');
    this.started = true; this.rejectStartup = undefined;
  }
  status(): { appId: string; state: string }[] { return this.entries.map(e => ({ appId: e.app.appId, state: this.stopped ? 'stopped' : e.client?.getConnectionStatus().state ?? 'idle' })); }
  stop(): void {
    if (this.stopped) return; this.stopped = true;
    for (const entry of this.entries) {
      clearTimeout(entry.timer); entry.reject(new BridgeError('ws_ingress_stopped'));
      try { entry.client?.close({ force: true }); } catch { this.notify('ws_failed'); } finally { activeApps.delete(appKey(entry.app)); }
    }
  }
}
