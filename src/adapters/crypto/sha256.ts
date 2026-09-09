import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';

export function sha256(value: string | Uint8Array) {
  return createHash('sha256').update(value).digest('hex');
}

/** Snapshot a prefix plus suffix without consuming the incremental prefix state. */
export function createIncrementalSha256() {
  const hash = createHash('sha256');
  return {
    update(value: string): void {
      hash.update(value);
    },
    digest(suffix = ''): string {
      return hash.copy().update(suffix).digest('hex');
    },
  };
}

export async function sha256File(filePath: string) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}
