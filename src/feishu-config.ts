import { z } from 'zod';
import type { FeishuApp } from './types.js';
const envName = z.string().regex(/^[A-Z][A-Z0-9_]*$/);
const definition = z.object({
  appId: z.string().regex(/^[A-Za-z0-9_-]+$/), tenantKey: z.string().min(1).max(256),
  appSecretEnv: envName, encryptKeyEnv: envName.optional(), verificationTokenEnv: envName.optional(),
  domain: z.enum(['feishu', 'lark']).default('feishu'),
  ingress: z.enum(['webhook', 'websocket']).default('webhook'),
  websocketExclusiveConsumer: z.boolean().optional()
}).strict().superRefine((a, ctx) => {
  if (a.ingress === 'webhook' && (!a.encryptKeyEnv || !a.verificationTokenEnv)) ctx.addIssue({ code: 'custom', message: 'Webhook ingress requires encryptKeyEnv and verificationTokenEnv' });
  if (a.ingress === 'websocket') {
    if (!/^cli_[0-9a-fA-F]{16}$/.test(a.appId)) ctx.addIssue({ code: 'custom', message: 'WebSocket ingress requires an official self-built app ID' });
    if (a.websocketExclusiveConsumer !== true) ctx.addIssue({ code: 'custom', message: 'Confirm this process is the only consumer of this app; otherwise integrate into the existing consumer' });
  }
});
/** Reading app credentials is left to the host's secret resolver; never log its values. */
export function loadFeishuApps(raw: unknown, secret: (name: string) => string): FeishuApp[] {
  const definitions = z.array(definition).min(1).parse(raw);
  if (new Set(definitions.map(a => a.appId)).size !== definitions.length) throw new Error('Duplicate app IDs');
  return definitions.map(a => ({
    appId: a.appId, tenantKey: a.tenantKey, domain: a.domain, ingress: a.ingress,
    websocketExclusiveConsumer: a.websocketExclusiveConsumer, appSecret: secret(a.appSecretEnv),
    // These fields are deliberately unused for WS; no pretend HTTP signature/secret check.
    encryptKey: a.ingress === 'webhook' ? secret(a.encryptKeyEnv!) : '',
    verificationToken: a.ingress === 'webhook' ? secret(a.verificationTokenEnv!) : ''
  }));
}

/** One person's installation uses a single object, never an account/app array. */
export function loadPersonalFeishuApp(raw: unknown, secret: (name: string) => string): FeishuApp {
  if (Array.isArray(raw)) throw new Error('Personal configuration requires exactly one app object, not an array');
  return loadFeishuApps([raw], secret)[0]!;
}
