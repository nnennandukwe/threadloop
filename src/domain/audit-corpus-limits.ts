export const MAX_AUDIT_CORPUS_BYTES = 16 * 1024 * 1024;
export const MAX_AUDIT_CORPUS_RECORDS = 32_768;

export class AuditCorpusLimitError extends Error {
  constructor() {
    super(
      `A corpus can contain at most ${MAX_AUDIT_CORPUS_BYTES} bytes and ${MAX_AUDIT_CORPUS_RECORDS} JSONL records.`,
    );
  }
}
