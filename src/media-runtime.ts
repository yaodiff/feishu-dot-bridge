import { BridgeError } from './types.js';
/** Default-off deployment switch, not a substitute for user approval. Unknown
 * values fail rather than silently enabling a broader media path. */
export function mediaInputEnabled(env: NodeJS.ProcessEnv): boolean {
  const mode = env.FEISHU_MEDIA_INPUT ?? 'disabled';
  if (mode !== 'disabled' && mode !== 'images-v1') throw new BridgeError('invalid_media_mode');
  return mode === 'images-v1';
}
