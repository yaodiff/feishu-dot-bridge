/** Bounded media policy used by the opt-in production media path. */
import { z } from 'zod';
import { BridgeError } from './types.js';

export const MEDIA_LIMITS = Object.freeze({ imageBytes: 4 * 1024 * 1024,
  maxPixels: 20_000_000, maxDimension: 8192, referenceTtlMs: 15 * 60_000,
  maxReferences: 128, maxConcurrent: 2, requestMs: 15_000 });
export type MediaKind = 'image';
export type MediaReference = Readonly<{ kind: MediaKind; resourceKey: string; resourceType: 'image' }>;
export type MediaParseFailure = 'unsupported_media' | 'invalid_media_reference';
export type MediaParseResult = { supported: true; reference: MediaReference } | { supported: false; reason: MediaParseFailure };
export const mediaNoticeSchema = z.object({ source: z.literal('feishu'), kind: z.literal('image').optional(),
  state: z.enum(['media_available', 'unsupported_media', 'invalid_media_reference', 'media_capacity_exceeded', 'media_expired', 'media_unavailable_after_restart', 'media_error', 'media_not_available', 'media_before_activation']),
  image_count: z.number().int().min(1).max(4).optional(), expires_at: z.string().datetime().optional(), at_receipt: z.boolean().optional() }).strict();
export type MediaNotice = z.infer<typeof mediaNoticeSchema>;
const key = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9_-]{1,240}$`));
const imageBody = z.object({ image_key: key('img') }).strict();

/** Only authenticated, same-message event content may reach this parser. Parsing
 * proves structure, not authorization. Rich posts use their own image-only parser.
 * Audio and other unsupported message types never retain a resource reference. */
export function parseMediaReference(messageType: string, raw: string): MediaParseResult {
  if (messageType !== 'image') return { supported: false, reason: 'unsupported_media' };
  try {
    if (raw.length > 4096) throw new Error();
    const content: unknown = JSON.parse(raw);
    return { supported: true, reference: Object.freeze({ kind: 'image', resourceType: 'image', resourceKey: imageBody.parse(content).image_key }) };
  } catch { return { supported: false, reason: 'invalid_media_reference' }; }
}

export function validateReference(ref: MediaReference): MediaReference {
  const parsed = ref.kind === 'image'
    ? parseMediaReference('image', JSON.stringify({ image_key: ref.resourceKey }))
    : undefined;
  if (!parsed?.supported || parsed.reference.resourceType !== ref.resourceType) throw new BridgeError('invalid_media_reference');
  return parsed.reference;
}

export function resourcePath(messageId: string, ref: MediaReference): string {
  validateReference(ref);
  if (!/^om_[A-Za-z0-9_-]{1,240}$/.test(messageId)) throw new BridgeError('invalid_media_reference');
  return `/open-apis/im/v1/messages/${messageId}/resources/${ref.resourceKey}?type=${ref.resourceType}`;
}
export function mediaByteLimit(kind: MediaKind): number {
  if (kind !== 'image') throw new BridgeError('unsupported_media');
  return MEDIA_LIMITS.imageBytes;
}
function dimensions(width: number, height: number): void {
  if (!width || !height || width > MEDIA_LIMITS.maxDimension || height > MEDIA_LIMITS.maxDimension || width * height > MEDIA_LIMITS.maxPixels) throw new BridgeError('image_dimensions_exceeded');
}

/** Bounded container/header validation, not a full decoder or malware scanner.
 * No filesystem decoding or automatic conversion. A reviewed decoder is a release gate. */
export function inspectMedia(bytes: Buffer, kind: MediaKind, declaredMime: string): { mimeType: string; width?: number; height?: number } {
  if (!bytes.length || bytes.length > mediaByteLimit(kind)) throw new BridgeError('media_size_exceeded');
  const declared = declaredMime.split(';')[0]!.trim().toLowerCase();
  let result: { mimeType: string; width?: number; height?: number } | undefined;
  if (kind === 'image') {
    if (bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
      // Walk every PNG chunk without decompressing it; reject APNG, trailing data,
      // impossible lengths, missing IDAT/IEND, and non-first/wrong-size IHDR.
      let at = 8, ihdr = false, idat = false, end = false;
      while (at + 12 <= bytes.length) {
        const length = bytes.readUInt32BE(at), type = bytes.toString('ascii', at + 4, at + 8);
        if (length > bytes.length - at - 12 || (at === 8 && (type !== 'IHDR' || length !== 13)) || type === 'acTL') throw new BridgeError('invalid_media_content');
        if (type === 'IHDR') {
          if (ihdr || at !== 8) throw new BridgeError('invalid_media_content');
          ihdr = true; const width = bytes.readUInt32BE(at + 8), height = bytes.readUInt32BE(at + 12); dimensions(width, height);
          result = { mimeType: 'image/png', width, height };
        }
        if (type === 'IDAT') idat = true;
        at += length + 12;
        if (type === 'IEND') { if (length || at !== bytes.length) throw new BridgeError('invalid_media_content'); end = true; break; }
      }
      if (!ihdr || !idat || !end) throw new BridgeError('invalid_media_content');
    } else if (bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) {
      let at = 2, sawScan = false;
      while (at + 4 <= bytes.length) {
        if (bytes[at++] !== 0xff) throw new BridgeError('invalid_media_content');
        while (bytes[at] === 0xff) at++;
        const marker = bytes[at++];
        if (marker === undefined || marker === 0xd9) break;
        if (marker === 0xda) {
          if (!result || at + 2 > bytes.length) throw new BridgeError('invalid_media_content');
          const length = bytes.readUInt16BE(at);
          if (length < 6 || at + length >= bytes.length - 2) throw new BridgeError('invalid_media_content');
          sawScan = true; break;
        }
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        if (at + 2 > bytes.length) break;
        const length = bytes.readUInt16BE(at);
        if (length < 2 || at + length > bytes.length) throw new BridgeError('invalid_media_content');
        if (marker === 0xc0 || marker === 0xc2) {
          if (length < 8 || result) throw new BridgeError('invalid_media_content');
          const height = bytes.readUInt16BE(at + 3), width = bytes.readUInt16BE(at + 5); dimensions(width, height);
          result = { mimeType: 'image/jpeg', width, height };
        }
        at += length;
      }
      if (!sawScan) throw new BridgeError('invalid_media_content');
    }
  }
  if (!result) throw new BridgeError('unsupported_image_format');
  const aliases = result.mimeType === 'image/jpeg' ? ['image/jpg'] : [];
  if (declared !== 'application/octet-stream' && declared !== result.mimeType && !aliases.includes(declared)) throw new BridgeError('media_mime_mismatch');
  return result;
}
