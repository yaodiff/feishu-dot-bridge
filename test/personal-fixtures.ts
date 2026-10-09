/** SYNTHETIC TEST/DEMO ONLY; never use these fixed values for a real installation. */
import { PersonalAuthenticator } from '../src/personal-auth.js';
import { Bridge } from '../src/bridge.js';
import { SecretBox } from '../src/crypto.js';
import { fixture, mockApp } from './fixtures.js';
export const MOCK_TOKEN_A = Buffer.alloc(32, 17).toString('base64url');
export const MOCK_TOKEN_B = Buffer.alloc(32, 23).toString('base64url');
export const MOCK_INSTALL_A = 'MOCK_installation_A';
export function personalFixture(installationId = MOCK_INSTALL_A, token = MOCK_TOKEN_A) {
  const f = fixture(); const auth = new PersonalAuthenticator(installationId, token, f.now);
  const bridge = new Bridge(f.store, new SecretBox(f.storageKey), f.transport, f.sender, f.now, { owner: auth.ownerId, appId: mockApp.appId, tenantKey: mockApp.tenantKey });
  return { ...f, auth, bridge, owner: { id: auth.ownerId, expiresAt: f.now() + 3600000 } };
}
