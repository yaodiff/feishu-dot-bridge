/** Dedicated decoder child. Receives only bounded bytes via IPC, never paths,
 * credentials, configuration, URLs, or a caller-selected operation. */
import sharp from 'sharp';
import { MEDIA_LIMITS } from './media-policy.js';
sharp.cache(false); sharp.concurrency(1);
sharp.block({ operation: ['VipsForeignLoad'] });
sharp.unblock({ operation: ['VipsForeignLoadJpegBuffer', 'VipsForeignLoadPngBuffer'] });
process.once('message', async (input: unknown) => {
  let bytes: Buffer | undefined;
  const chunks: Buffer[] = [];
  try {
    if (!Buffer.isBuffer(input) || !input.length || input.length > MEDIA_LIMITS.imageBytes) throw new Error();
    bytes = input;
    const options = { failOn: 'warning' as const, limitInputPixels: MEDIA_LIMITS.maxPixels, limitInputChannels: 4, sequentialRead: true, animated: false };
    const metadata = await sharp(bytes, options).metadata();
    if (!['png', 'jpeg'].includes(metadata.format ?? '') || !metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1 || metadata.width > MEDIA_LIMITS.maxDimension || metadata.height > MEDIA_LIMITS.maxDimension) throw new Error();
    // Re-encode all pixels to PNG, orient before removing EXIF, retain alpha.
    // No keepMetadata/withMetadata: EXIF/XMP/IPTC/ICC and filenames are removed.
    const pipeline = sharp(bytes, options).rotate().resize({ width: 4096, height: 4096, fit: 'inside', withoutEnlargement: true })
      .toColourspace('srgb').png({ compressionLevel: 6 }).timeout({ seconds: 6 });
    let size = 0, width = 0, height = 0;
    pipeline.once('info', info => { width = info.width; height = info.height; });
    try { for await (const data of pipeline) {
      if (!Buffer.isBuffer(data) || (size += data.length) > MEDIA_LIMITS.imageBytes) throw new Error();
      chunks.push(data);
    } } finally { pipeline.destroy(); }
    if (!size || !width || !height || width > 4096 || height > 4096) throw new Error();
    const result = Buffer.concat(chunks, size);
    process.send?.({ ok: true, bytes: result, width, height, originalWidth: metadata.width, originalHeight: metadata.height }, () => { result.fill(0); process.disconnect?.(); });
  } catch { process.send?.({ ok: false }, () => process.disconnect?.()); }
  finally { bytes?.fill(0); for (const chunk of chunks) chunk.fill(0); }
});
