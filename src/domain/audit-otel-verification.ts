import { AuditCorpusError, verifyAuditCorpus } from './audit-corpus.js';
import { AuditCorpusLimitError, MAX_AUDIT_CORPUS_BYTES, MAX_AUDIT_CORPUS_RECORDS } from './audit-corpus-limits.js';
import { AUDIT_OTEL_PROFILE, renderAuditOtel } from './audit-otel.js';
import { isPlainObject } from './canonical-json.js';
import type { ProofDigest } from './proof.js';

export class AuditOtelProjectionError extends AuditCorpusError {
  constructor() {
    super(
      'The otel viewer projection omits native audit records. Export with --format otel-verifiable to verify the audit chain.',
    );
  }
}

function singleContainer(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value) || value.length !== 1 || !isPlainObject(value[0]))
    throw new AuditCorpusError('Each OTel envelope must contain one resource, one scope and one log record.');
  return value[0];
}

function stringAttribute(attributes: unknown, key: string): string {
  if (!Array.isArray(attributes)) throw new AuditCorpusError('The OTel attribute list is missing.');
  let result: string | undefined;
  for (const attribute of attributes as unknown[]) {
    if (!isPlainObject(attribute) || attribute.key !== key) continue;
    const value = attribute.value;
    if (
      result !== undefined ||
      !isPlainObject(value) ||
      Object.keys(value).length !== 1 ||
      typeof value.stringValue !== 'string'
    )
      throw new AuditCorpusError(`Expected one string value for ${key}.`);
    result = value.stringValue;
  }
  if (result === undefined) throw new AuditCorpusError(`Missing OTel attribute ${key}.`);
  return result;
}

function readNativeLine(line: string, index: number) {
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch (cause) {
    throw new AuditCorpusError(`OTel record ${index + 1} contains invalid JSON.`, { cause });
  }
  if (!isPlainObject(row)) throw new AuditCorpusError('Expected an OTel LogsData envelope.');
  const resource = singleContainer(row.resourceLogs);
  const scope = singleContainer(resource.scopeLogs);
  const log = singleContainer(scope.logRecords);
  if (
    !isPlainObject(scope.scope) ||
    stringAttribute(scope.scope.attributes, 'threadloop.audit.profile') !== AUDIT_OTEL_PROFILE
  )
    throw new AuditCorpusError('Unsupported OTel audit profile.');
  const format = stringAttribute(scope.scope.attributes, 'threadloop.audit.format');
  if (index === 0 && format === 'otel') throw new AuditOtelProjectionError();
  if (format !== 'otel-verifiable') throw new AuditCorpusError('Expected otel-verifiable on every OTel record.');
  const native = stringAttribute(log.attributes, 'threadloop.audit.canonical_record');
  if (native.length === 0 || /[\r\n]/.test(native))
    throw new AuditCorpusError(
      'Each canonical_record must contain exactly one native JSONL record without its newline.',
    );
  return native;
}

export function verifyAuditOtel(content: string, digest: ProofDigest, expectedRoot?: string) {
  if (Buffer.byteLength(content) > MAX_AUDIT_CORPUS_BYTES) throw new AuditCorpusLimitError();
  if (!content.endsWith('\n')) throw new AuditCorpusError('An OTel audit export must end with a newline.');
  const lines = content.slice(0, -1).split('\n', MAX_AUDIT_CORPUS_RECORDS + 1);
  if (lines.length > MAX_AUDIT_CORPUS_RECORDS) throw new AuditCorpusLimitError();
  const nativeContent = lines.map(readNativeLine).join('\n') + '\n';
  if (expectedRoot !== undefined && expectedRoot !== digest(content))
    throw new AuditCorpusError("The retained root doesn't match the OTel export.");
  const native = verifyAuditCorpus(nativeContent, digest);
  const rendered = renderAuditOtel({ ...native, content: nativeContent }, 'otel-verifiable', digest);
  if (rendered.content !== content)
    throw new AuditCorpusError("The OTel envelope doesn't match the projection of its retained native corpus.");
  return {
    valid: true as const,
    root: rendered.root,
    source_root: native.root,
    format: 'otel-verifiable' as const,
    profile: AUDIT_OTEL_PROFILE,
    manifest: native.manifest,
    session_count: native.session_count,
    event_count: native.event_count,
  };
}
