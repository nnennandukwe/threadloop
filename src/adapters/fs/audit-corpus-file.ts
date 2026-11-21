import { isUtf8 } from 'node:buffer';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { buffer } from 'node:stream/consumers';

export const MAX_AUDIT_CORPUS_BYTES = 16 * 1024 * 1024;
export const MAX_AUDIT_CORPUS_RECORDS = 32_768;

export class AuditCorpusLimitError extends Error {
  constructor() {
    super(
      `A corpus can contain at most ${MAX_AUDIT_CORPUS_BYTES} bytes and ${MAX_AUDIT_CORPUS_RECORDS} JSONL records.`,
    );
  }
}

export function assertAuditCorpusLimits(content: string, byteLength = Buffer.byteLength(content)) {
  if (byteLength > MAX_AUDIT_CORPUS_BYTES) throw new AuditCorpusLimitError();
  let records = 0;
  for (let newline = content.indexOf('\n'); newline >= 0; newline = content.indexOf('\n', newline + 1)) {
    if (++records > MAX_AUDIT_CORPUS_RECORDS) throw new AuditCorpusLimitError();
  }
}

export async function readAuditCorpusFile(filename: string) {
  const file = await open(filename, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) throw new Error('Corpus verification requires a regular file.');
    if (metadata.size > MAX_AUDIT_CORPUS_BYTES) throw new AuditCorpusLimitError();
    // The inclusive end allows one extra byte to detect growth after the size check.
    const bytes = await buffer(file.createReadStream({ start: 0, end: MAX_AUDIT_CORPUS_BYTES, autoClose: false }));
    if (bytes.length > MAX_AUDIT_CORPUS_BYTES) throw new AuditCorpusLimitError();
    if (bytes.length !== metadata.size) throw new Error('The corpus file changed size during verification.');
    if (!isUtf8(bytes)) throw new Error('Export contains invalid UTF-8 bytes.');
    const content = bytes.toString('utf8');
    assertAuditCorpusLimits(content, bytes.length);
    return content;
  } finally {
    await file.close();
  }
}
