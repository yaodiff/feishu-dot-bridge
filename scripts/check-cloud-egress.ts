import { OpenAiManagedProxyCallback } from '../src/callback-proxy-candidate.js';
try {
  const candidate = new OpenAiManagedProxyCallback();
  const result = await candidate.probe();
  console.log(JSON.stringify({ probe: 'public_callback_root_HEAD', status: result.status, tlsValidationRequired: true, applicationDnsPinning: false, liveCallbackEnabled: false }));
} catch (error) {
  console.log(JSON.stringify({ probe: 'public_callback_root_HEAD', error: error instanceof Error ? error.message : 'unknown', liveCallbackEnabled: false }));
  process.exitCode = 1;
}
