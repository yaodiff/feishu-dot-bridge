import { createHash, timingSafeEqual } from 'node:crypto';
import { BridgeError, type Principal } from './types.js';
import { hash } from './crypto.js';
export const PERSONAL_HEADER = 'x-bridge-token';
export function installationOwner(installationId: string): string {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(installationId)) throw new Error('INSTALLATION_ID must be a stable unique 16–128 character identifier');
  return hash(`feishu-dot-installation:${installationId}`);
}
function validToken(token: string): boolean { return /^[A-Za-z0-9_-]{43}$/.test(token) && Buffer.from(token, 'base64url').length === 32 && Buffer.from(token, 'base64url').toString('base64url') === token; }
/** Installation authentication, NOT per-request ChatGPT-user authentication.
 * Safe only behind an owner-only private tunnel with the HTTP listener on loopback. */
export class PersonalAuthenticator {
  readonly ownerId: string;
  private digest: Buffer;
  constructor(installationId: string, credential: string, private now: () => number = Date.now) {
    this.ownerId = installationOwner(installationId);
    if (!validToken(credential)) throw new Error('BRIDGE_TOKEN must be an independently generated 32-byte base64url secret');
    this.digest = createHash('sha256').update(credential).digest();
  }
  async authenticate(header: string | null): Promise<Principal> {
    if (!header || !validToken(header)) throw new BridgeError('unauthorized', 401);
    const digest = createHash('sha256').update(header).digest();
    if (!timingSafeEqual(this.digest, digest)) throw new BridgeError('unauthorized', 401);
    // A finite lease, even though local backend credentials are rotated administratively.
    return { id: this.ownerId, expiresAt: this.now() + 3600000 };
  }
}
