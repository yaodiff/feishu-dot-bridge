import { PublicHttpsCallback } from './callback.js';
import { OpenAiManagedProxyCallback, OPENAI_CALLBACK_HOST, type CallbackPostDiagnosticHook } from './callback-proxy-candidate.js';
import type { CallbackTransport } from './types.js';

export function createCallbackTransport(env: NodeJS.ProcessEnv, onBlockedHost?: (host: string) => void, onDiagnostic?: CallbackPostDiagnosticHook): CallbackTransport {
  const mode = env.CALLBACK_TRANSPORT ?? 'direct-pinned';
  if (mode === 'managed-proxy-openai-candidate') throw new Error('callback_proxy_candidate_disabled_security_review_required');
  if (mode === 'managed-proxy-openai') {
    const hosts = (env.CALLBACK_HOSTS ?? '').split(',').map(s => s.trim()).filter(Boolean);
    if (hosts.length !== 1 || hosts[0] !== OPENAI_CALLBACK_HOST) throw new Error('managed_proxy_requires_exact_openai_callback_host');
    return new OpenAiManagedProxyCallback(env, onDiagnostic);
  }
  if (mode !== 'direct-pinned') throw new Error('invalid_callback_transport');
  if (!env.CALLBACK_HOSTS) throw new Error('CALLBACK_HOSTS must be configured');
  return new PublicHttpsCallback(env.CALLBACK_HOSTS.split(',').map(s => s.trim()).filter(Boolean), onBlockedHost);
}
