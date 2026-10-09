/** Real HTTPS through a synthetic loopback CONNECT proxy; never uses live services. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, chmodSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';

const HOST = 'connectors.api.openai.com';
let dir: string, cert: string, key: string, wrongCert: string, wrongKey: string, caBundle: string;
const results: Record<string, unknown>[] = [];
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'MOCK-callback-pool-')); key = join(dir, 'key.pem'); cert = join(dir, 'cert.pem'); wrongKey = join(dir, 'wrong-key.pem'); wrongCert = join(dir, 'wrong-cert.pem'); caBundle = join(dir, 'ca-bundle.pem');
  for (const [subject, outputKey, outputCert] of [[HOST, key, cert], ['wrong.invalid', wrongKey, wrongCert]]) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', outputKey!, '-out', outputCert!, '-subj', `/CN=${subject}`, '-addext', `subjectAltName=DNS:${subject}`, '-days', '1'], { stdio: 'ignore' }); chmodSync(outputKey!, 0o600);
  }
  writeFileSync(caBundle, readFileSync(cert).toString() + readFileSync(wrongCert).toString());
});
after(() => {
  if (process.env.CALLBACK_POOL_REPORT) writeFileSync(process.env.CALLBACK_POOL_REPORT, JSON.stringify({ generatedAt: new Date().toISOString(), node: process.version, localOnly: true, realWorldPerformanceVerified: false, results }, null, 2) + '\n');
  if (dir) rmSync(dir, { recursive: true, force: true });
});
async function runScenario(name: string, maxMs = 10000) {
  const started = performance.now();
  // Explicit env: no inherited provider credentials, proxy authentication, or trust bypasses.
  const child = spawn(process.execPath, [resolve('dist/test/callback-pool-worker.js'), name], { env: { PATH: process.env.PATH, MOCK_CERT: cert, MOCK_KEY: key, MOCK_WRONG_KEY: wrongKey, MOCK_WRONG_CERT: wrongCert, MOCK_BASELINE: resolve('dist/test/fixtures/callback-unpooled-baseline.js'), ...(name !== 'trust-rejection' ? { NODE_EXTRA_CA_CERTS: caBundle } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', stderr = ''; child.stdout.on('data', data => output += data.toString()); child.stderr.on('data', data => stderr += data.toString());
  const watchdog = setTimeout(() => child.kill('SIGKILL'), maxMs);
  let code: unknown, signal: unknown; try { [code, signal] = await once(child, 'exit'); } finally { clearTimeout(watchdog); }
  assert.equal(code, 0, `${name}: worker must exit naturally with no lingering handles (signal=${String(signal)}).\n${stderr}\n${output}`);
  assert.equal(stderr, '', `${name}: no uncaught errors or listener leak warnings`);
  const result = JSON.parse(output.trim()); assert.equal(result.ok, true); assert.equal(result.socketsBeforeFixtureTeardown, 0);
  result.workerWallMs = Math.round(performance.now() - started); results.push(result); return result;
}
test('callback pool: baseline snapshot integrity', () => {
  const original = readFileSync(resolve('test/fixtures/callback-unpooled-baseline.ts'), 'utf8').replace("from '../../src/types.js'", "from './types.js'");
  assert.equal(createHash('sha256').update(original).digest('hex'), '04cb26db18fc24644f4bc92022ae5d9d070932e4df2c5359958e1588dde89655');
});
const scenarios = [
  ['reuse-isolation', 10000], ['concurrency-fifo', 10000], ['queue-saturation-cancel', 10000],
  ['abort-before-connect-socket', 10000], ['abort-after-release', 10000], ['cancel-connect', 10000], ['cancel-tls', 10000], ['cancel-active', 10000],
  ['peer-close-no-replay', 10000], ['stale-at-assignment', 10000], ['request-cap', 10000],
  ['close-shutdown', 10000], ['trust-rejection', 10000], ['sni-hostname-rejection', 10000],
  ['connect-deadline', 15000], ['tls-deadline', 20000], ['queue-total-deadline', 20000],
  ['queue-connect-total-deadline', 20000], ['idle-ttl', 36000], ['benchmark', 15000]
] as const;
for (const [name, timeout] of scenarios) test(`callback pool: ${name}`, { timeout: timeout + 3000 }, async t => {
  const result = await runScenario(name, timeout); t.diagnostic(JSON.stringify(result));
});
