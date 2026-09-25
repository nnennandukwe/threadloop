import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';

export function sha256(value: string | Uint8Array) {
  return createHash('sha256').update(value).digest('hex');
}

export async function sha256File(filePath: string) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}
