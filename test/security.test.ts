import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { JwtAuthenticator } from '../src/auth.js';
import { isPublicAddress, validateCallbackUrl } from '../src/callback.js';
import { decodeFeishu } from '../src/feishu.js';
import { encryptedCallback, feishuPayload, mockApp } from './fixtures.js';
test('JWT requires signature, issuer, audience, subject, bounded expiry and scope', async () => {
  const keys = await generateKeyPair('RS256'); const key = createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), alg: 'RS256' }] });
  const auth = new JwtAuthenticator('https://idp.example', 'https://bridge.example/mcp', key);
  const now = Math.floor(Date.now() / 1000);
  const sign = (overrides: Record<string, unknown> = {}) => new SignJWT({ iss: 'https://idp.example', aud: 'https://bridge.example/mcp', sub: 'alice', iat: now, exp: now + 900, scope: 'bridge:use', ...overrides }).setProtectedHeader({ alg: 'RS256' }).sign(keys.privateKey);
  const good = await sign(); assert.ok((await auth.authenticate(`Bearer ${good}`)).id);
  for (const overrides of [{ iss: 'https://evil.example' }, { aud: 'other' }, { exp: now - 20 }, { exp: undefined }, { sub: undefined }, { iat: undefined }, { exp: now + 7200 }, { scope: 'other' }]) await assert.rejects(auth.authenticate(`Bearer ${await sign(overrides)}`), /unauthorized/);
  await assert.rejects(auth.authenticate(null)); await assert.rejects(auth.authenticate('Bearer alice')); await assert.rejects(auth.authenticate(`Bearer ${good.slice(0, -10)}corruption`));
});
test('callback SSRF blocks private, loopback, metadata, mapped IPv6, link-local and reserved networks', () => {
  for (const ip of ['127.0.0.1','10.1.2.3','172.16.1.1','192.168.0.1','169.254.169.254','0.0.0.0','100.64.1.2','224.0.0.1','::1','fe80::1','fc00::1','::ffff:127.0.0.1','2001:db8::1']) assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress('8.8.8.8'), true); assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  for (const url of ['http://callback.example/x','https://evil.example/x','https://callback.example.evil/x','https://u:p@callback.example/x','https://callback.example:444/x','https://callback.example/x#fragment','https://127.0.0.1/x']) assert.throws(() => validateCallbackUrl(url, ['callback.example']));
  assert.equal(validateCallbackUrl('https://callback.example/x', ['callback.example']).hostname, 'callback.example');
});
test('Feishu verifies raw-byte signature, timestamp, encrypted body, token, app and tenant', () => {
  const c = encryptedCallback(feishuPayload()); assert.ok('message' in decodeFeishu(mockApp, c.raw, new Headers(c.headers)));
  assert.throws(() => decodeFeishu(mockApp, c.raw + ' ', new Headers(c.headers)), /signature/);
  assert.throws(() => decodeFeishu(mockApp, c.raw, new Headers(c.headers), Date.now() + 600000), /signature/);
  for (const payload of [feishuPayload('x', { appId: 'cli_evil' }), feishuPayload('x', { tenant: 'tenant_other' })]) { const bad = encryptedCallback(payload); assert.throws(() => decodeFeishu(mockApp, bad.raw, new Headers(bad.headers)), /identity/); }
  const badToken = feishuPayload(); badToken.header.token = 'wrong'; const bad = encryptedCallback(badToken); assert.throws(() => decodeFeishu(mockApp, bad.raw, new Headers(bad.headers)), /identity/);
});
test('bot/system messages, groups and non-text never enter binding or event pipeline', () => {
  for (const extras of [{ sender: 'bot' }, { sender: 'system' }, { chatType: 'group' }, { type: 'audio' }]) { const c = encryptedCallback(feishuPayload('/bind could-be-a-code', extras)); assert.deepEqual(decodeFeishu(mockApp, c.raw, new Headers(c.headers)), { ignored: true }); }
});
test('encrypted challenge requires verification token', () => { const c = encryptedCallback({ type: 'url_verification', token: mockApp.verificationToken, challenge: 'challenge' }); assert.deepEqual(decodeFeishu(mockApp, c.raw, new Headers(c.headers)), { challenge: 'challenge' }); });
