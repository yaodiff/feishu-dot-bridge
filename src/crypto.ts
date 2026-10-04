import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
export const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = () => randomBytes(24).toString('base64url');
export function equal(a: string, b: string): boolean { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
export class SecretBox {
  constructor(private key: Buffer) { if (key.length !== 32) throw new Error('STORAGE_KEY must decode to 32 bytes'); }
  seal(value: string): string { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', this.key, iv); return Buffer.concat([iv, c.update(value), c.final(), c.getAuthTag()]).toString('base64'); }
  open(value: string): string { const b = Buffer.from(value, 'base64'); const d = createDecipheriv('aes-256-gcm', this.key, b.subarray(0, 12)); d.setAuthTag(b.subarray(-16)); return Buffer.concat([d.update(b.subarray(12, -16)), d.final()]).toString(); }
}
