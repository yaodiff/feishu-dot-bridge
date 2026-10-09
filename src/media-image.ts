import { fork } from 'node:child_process';
import { BridgeError } from './types.js';
import { MEDIA_LIMITS, inspectMedia } from './media-policy.js';
export interface SanitizedImage { bytes: Buffer; mimeType: 'image/png'; width: number; height: number; originalWidth: number; originalHeight: number }
export async function verifyImageDecoder(): Promise<void> {
  // Generated one-pixel fixture, no external data. Fail startup before credentials
  // or the DB are opened if the pinned decoder/resource limiter cannot operate.
  const fixture = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  try { const image = await sanitizeImage(fixture, 'image/png', new AbortController().signal); image.bytes.fill(0); }
  catch { throw new BridgeError('image_decoder_unavailable'); }
  finally { fixture.fill(0); }
}
/** Full decode/re-encode in a separate short-lived process with a minimal env.
 * No user bytes written to disk, output URLs, shell command, or decoder filename.
 * OS cgroup memory limits remain recommended for deployment defense in depth. */
export function sanitizeImage(bytes: Buffer, declaredMime: string, signal: AbortSignal): Promise<SanitizedImage> {
  inspectMedia(bytes, 'image', declaredMime);
  if (signal.aborted) return Promise.reject(new BridgeError('media_cancelled'));
  return new Promise((resolve, reject) => {
    let settled = false, diagnostics = 0;
    const child = fork(new URL('./media-image-worker.js', import.meta.url), [], {
      // Mandatory Linux resource limiter: no unbounded fallback if unavailable.
      // jitless avoids V8's large executable CodeRange reservation under RLIMIT_DATA.
      execPath: '/usr/bin/prlimit', execArgv: ['--core=0', '--fsize=0', '--data=1073741824', '--cpu=8', '--nofile=64', '--', process.execPath, '--jitless', '--max-old-space-size=128'], serialization: 'advanced', silent: true,
      // Native random-access spill attempts must fail, never create blob files.
      env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', TMPDIR: '/dev/null', TMP: '/dev/null', TEMP: '/dev/null', LANG: 'C', VIPS_CONCURRENCY: '1' }
    });
    const finish = (error?: BridgeError, result?: SanitizedImage) => {
      if (settled) { result?.bytes.fill(0); return; } settled = true;
      clearTimeout(timer); signal.removeEventListener('abort', abort); child.kill('SIGKILL');
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => finish(new BridgeError('media_cancelled'));
    const timer = setTimeout(() => finish(new BridgeError('image_decode_timeout')), 8000);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const drain = (data: Buffer) => { diagnostics += data.length; if (diagnostics > 4096) finish(new BridgeError('invalid_media_content')); };
    child.stdout?.on('data', drain); child.stderr?.on('data', drain);
    child.once('error', () => finish(new BridgeError('image_decoder_unavailable')));
    child.once('exit', () => { if (!settled) finish(new BridgeError('invalid_media_content')); });
    child.on('message', (message: any) => {
      if (!message?.ok || !Buffer.isBuffer(message.bytes) || !message.bytes.length || message.bytes.length > MEDIA_LIMITS.imageBytes ||
        ![message.width, message.height, message.originalWidth, message.originalHeight].every((x: unknown) => Number.isSafeInteger(x) && Number(x) > 0 && Number(x) <= MEDIA_LIMITS.maxDimension)) {
        if (Buffer.isBuffer(message?.bytes)) message.bytes.fill(0);
        finish(new BridgeError('invalid_media_content')); return;
      }
      try { inspectMedia(message.bytes, 'image', 'image/png'); }
      catch { message.bytes.fill(0); finish(new BridgeError('invalid_media_content')); return; }
      finish(undefined, { bytes: message.bytes, mimeType: 'image/png', width: message.width, height: message.height, originalWidth: message.originalWidth, originalHeight: message.originalHeight });
    });
    if (!settled) child.send(bytes, error => { if (error) finish(new BridgeError('image_decoder_unavailable')); });
  });
}
