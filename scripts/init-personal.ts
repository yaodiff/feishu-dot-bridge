/** Run deliberately on YOUR host. Never executed automatically by npm install/start. */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
const root = process.cwd(), config = resolve(root, 'config');
// Refuse adoption/overwrites: operator must handle an existing installation explicitly.
if (['.env', 'config', 'data'].some(name => existsSync(resolve(root, name)))) throw new Error('Existing .env/config/data found; initialization refuses to overwrite or adopt them');
process.umask(0o077);
mkdirSync(config, { mode: 0o700 });
const tokenPath = resolve(config, 'bridge-token'), storagePath = resolve(config, 'storage-key');
writeFileSync(tokenPath, randomBytes(32).toString('base64url') + '\n', { mode: 0o600, flag: 'wx' });
writeFileSync(storagePath, randomBytes(32).toString('base64') + '\n', { mode: 0o600, flag: 'wx' });
writeFileSync(resolve(config, 'feishu-app.json'), JSON.stringify({ appId: 'cli_0000000000000000', tenantKey: 'REPLACE_WITH_VERIFIED_TENANT_KEY', appSecretEnv: 'FEISHU_APP_SECRET', domain: 'feishu', ingress: 'websocket', websocketExclusiveConsumer: false }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
writeFileSync(resolve(root, '.env'), [
  'AUTH_MODE=personal-tunnel', `INSTALLATION_ID=${randomUUID()}`, 'HOST=127.0.0.1', 'PORT=3000',
  `BRIDGE_TOKEN_FILE=${tokenPath}`, `STORAGE_KEY_FILE=${storagePath}`, 'FEISHU_APP_FILE=./config/feishu-app.json',
  'DATABASE_PATH=./data/personal.sqlite', 'CALLBACK_HOSTS=callback.invalid', 'FEISHU_APP_SECRET=', ''
].join('\n'), { mode: 0o600, flag: 'wx' });
console.log('Created private personal configuration. No secret values are displayed.');
console.log('Fill the verified Feishu app/tenant and existing app credential locally. Verify exclusive WS ownership before enabling it.');
console.log('Keep the bridge on loopback and connect an owner-only official Tunnel. Never share the tunnel/app with another user.');
