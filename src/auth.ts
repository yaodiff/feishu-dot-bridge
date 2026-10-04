import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { hash } from './crypto.js';
import { BridgeError, type Principal } from './types.js';
export class JwtAuthenticator {
  private key: JWTVerifyGetKey;
  constructor(readonly issuer: string, readonly audience: string, jwks: URL | JWTVerifyGetKey, private scope = 'bridge:use') {
    this.key = jwks instanceof URL ? createRemoteJWKSet(jwks, { timeoutDuration: 5000 }) : jwks;
  }
  async authenticate(header: string | null): Promise<Principal> {
    const token = /^Bearer ([^\s]+)$/.exec(header ?? '')?.[1];
    if (!token || token.length > 16384) throw new BridgeError('unauthorized', 401);
    try {
      const { payload } = await jwtVerify(token, this.key, { issuer: this.issuer, audience: this.audience, algorithms: ['RS256', 'ES256'], requiredClaims: ['sub', 'iat', 'exp'], clockTolerance: 5, maxTokenAge: '1h' });
      if (!payload.sub || typeof payload.exp !== 'number' || typeof payload.iat !== 'number' || payload.exp - payload.iat > 3600 || typeof payload.scope !== 'string' || !payload.scope.split(' ').includes(this.scope)) throw new Error('claims');
      return { id: hash(JSON.stringify([this.issuer, payload.sub])), expiresAt: payload.exp * 1000 };
    } catch { throw new BridgeError('unauthorized', 401); }
  }
}
