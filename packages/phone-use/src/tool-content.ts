import { readFile } from 'node:fs/promises';
import type { ToolContent } from './harness.ts';

/** Interpret only renderer-owned image paths, never arbitrary text as a file. */
export async function toolContent(result: string, imagePath = false): Promise<ToolContent[]> {
  const marker = '\n[vision] ';
  const index = result.lastIndexOf(marker);
  const path =
    imagePath && result.startsWith('/')
      ? result
      : index >= 0
        ? result.slice(index + marker.length).trim()
        : undefined;
  const text = index >= 0 ? result.slice(0, index) : result;
  if (!path?.startsWith('/')) return [{ type: 'text', text: result }];
  try {
    const bytes = await readFile(path);
    if (bytes.length > 5 * 1024 * 1024) throw new Error('image exceeds 5 MiB');
    const mimeType = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? 'image/png'
      : bytes[0] === 255 && bytes[1] === 216
        ? 'image/jpeg'
        : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
          ? 'image/webp'
          : null;
    if (!mimeType) throw new Error('unsupported image format');
    return [
      { type: 'text', text },
      { type: 'image', mimeType, data: bytes.toString('base64') },
    ];
  } catch (error) {
    return [
      {
        type: 'text',
        text: `${text}\nImage unavailable: ${String(error)}. Do not infer visual state; observe again or report unverified.`,
      },
    ];
  }
}
