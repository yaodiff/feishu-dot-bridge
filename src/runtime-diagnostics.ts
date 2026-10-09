/** Narrow, model-visible diagnostics. Never forward arbitrary child fields. */
const stages = new Set(['validation', 'proxy_connect', 'tls_handshake', 'request', 'response']);
const outcomes = new Set(['started', 'succeeded', 'failed']);
const transportReasons = new Set(['none', 'invalid_callback', 'invalid_callback_headers', 'callback_request_too_large', 'callback_timeout', 'callback_proxy_connect_failed', 'callback_tls_failed', 'callback_failed', 'callback_redirect_rejected', 'callback_response_too_large', 'callback_upgrade_rejected']);
const verificationReasons = new Set(['request_failed', 'over_budget', 'http_status', 'invalid_json', 'challenge_missing', 'challenge_mismatch', 'verified']);
export function sanitizeRuntimeDiagnostic(value: unknown): Record<string, string | number> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.event === 'bridge_start_failure') {
    if (typeof v.reason !== 'string' || !['ws_start_timeout', 'ws_start_failed', 'duplicate_ws_consumer', 'invalid_ws_configuration', 'ws_ingress_stopped', 'other'].includes(v.reason)) return null;
    return { event: v.event, reason: v.reason };
  }
  if (v.event === 'bridge_ws_lifecycle') {
    if (typeof v.state !== 'string' || !['ws_connecting', 'ws_ready', 'ws_reconnecting', 'ws_reconnected', 'ws_failed'].includes(v.state)) return null;
    return { event: v.event, state: v.state };
  }
  if (!Number.isInteger(v.elapsedMs) || (v.elapsedMs as number) < 0 || (v.elapsedMs as number) > 60000) return null;
  if (v.httpStatus !== undefined && (!Number.isInteger(v.httpStatus) || (v.httpStatus as number) < 100 || (v.httpStatus as number) > 599)) return null;
  let result: Record<string, string | number>;
  if (v.event === 'callback_verification') {
    if (typeof v.reason !== 'string' || !verificationReasons.has(v.reason)) return null;
    result = { event: v.event, reason: v.reason, elapsedMs: v.elapsedMs as number };
  } else if (v.event === 'callback_transport') {
    if (typeof v.stage !== 'string' || !stages.has(v.stage) || typeof v.outcome !== 'string' || !outcomes.has(v.outcome) || typeof v.reason !== 'string' || !transportReasons.has(v.reason)) return null;
    if (v.hostname !== undefined && v.hostname !== 'connectors.api.openai.com') return null;
    result = { event: v.event, stage: v.stage, outcome: v.outcome, reason: v.reason, elapsedMs: v.elapsedMs as number };
    if (v.hostname === 'connectors.api.openai.com') result.hostname = v.hostname;
  } else return null;
  if (v.httpStatus !== undefined) result.httpStatus = v.httpStatus as number;
  return result;
}
