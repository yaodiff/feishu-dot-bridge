import { readConfiguredSecret } from './private-file.js';
import { PersonalAuthenticator } from './personal-auth.js';
export type AuthMode = 'personal-tunnel' | 'oauth';
export interface RuntimeConfig { mode: AuthMode; host: string; port: number; baseUrl: string; allowedHosts: string[]; appFile: string; databasePath: string; personalAuth?: PersonalAuthenticator; issuer?: string; jwksUrl?: URL }
function required(env: NodeJS.ProcessEnv, name: string): string { const value = env[name]; if (!value) throw new Error(`Missing ${name}`); return value; }
function https(value: string): URL { const u = new URL(value); if (u.protocol !== 'https:' || u.username || u.password || u.hash || u.search) throw new Error('Expected an HTTPS URL without credentials, query or fragment'); return u; }
export function loadRuntimeConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  const mode = env.AUTH_MODE ?? 'personal-tunnel';
  if (mode !== 'personal-tunnel' && mode !== 'oauth') throw new Error('AUTH_MODE must be personal-tunnel or oauth');
  const host = env.HOST ?? '127.0.0.1', port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  if (mode === 'personal-tunnel') {
    if (host !== '127.0.0.1' && host !== '::1') throw new Error('personal-tunnel requires an exact loopback HOST (127.0.0.1 or ::1)');
    if (['PUBLIC_URL', 'OAUTH_ISSUER', 'OAUTH_JWKS_URL', 'FEISHU_APPS_FILE'].some(name => env[name] !== undefined)) throw new Error('Public/OAuth/multi-app settings are incompatible with personal-tunnel; use the personal template or explicitly select AUTH_MODE=oauth');
    const allowedHost = `${host === '::1' ? '[::1]' : host}:${port}`;
    if (env.ALLOWED_HOSTS !== undefined && env.ALLOWED_HOSTS !== allowedHost) throw new Error('personal-tunnel ALLOWED_HOSTS must match the exact loopback listener');
    const personalAuth = new PersonalAuthenticator(required(env, 'INSTALLATION_ID'), readConfiguredSecret(env, 'BRIDGE_TOKEN'));
    return { mode, host, port, baseUrl: `http://${allowedHost}`, allowedHosts: [allowedHost], appFile: env.FEISHU_APP_FILE ?? './config/feishu-app.json', databasePath: env.DATABASE_PATH ?? './data/personal.sqlite', personalAuth };
  }
  const publicUrl = https(required(env, 'PUBLIC_URL'));
  if (publicUrl.pathname !== '/') throw new Error('PUBLIC_URL must be an HTTPS origin');
  if (env.BRIDGE_TOKEN !== undefined || env.BRIDGE_TOKEN_FILE !== undefined) throw new Error('Remove personal backend credentials when selecting oauth mode');
  const issuer = required(env, 'OAUTH_ISSUER'); https(issuer); // Validate without normalizing the exact issuer.
  return { mode, host, port, baseUrl: publicUrl.origin, allowedHosts: (env.ALLOWED_HOSTS ?? publicUrl.host).split(','), appFile: env.FEISHU_APPS_FILE ?? './config/feishu-apps.json', databasePath: env.DATABASE_PATH ?? './data/bridge.sqlite', issuer, jwksUrl: https(required(env, 'OAUTH_JWKS_URL')) };
}
