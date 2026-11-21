import path from 'node:path';
import { sha256 } from '../adapters/crypto/sha256.js';
import { assertAuditCorpusLimits, readAuditCorpusFile } from '../adapters/fs/audit-corpus-file.js';
import { AuditExportConflictError, writeAuditExportExclusive } from '../adapters/fs/audit-export.js';
import {
  CURRENT_SCHEMA_VERSION,
  inspectAuditLedgerReadOnly,
  readAuditCorpusReadOnly,
  AuditLedgerUnavailableError,
  StateDatabaseMissingError,
} from '../adapters/fs/sqlite-store.js';
import { ThreadloopError } from '../contracts/errors.js';
import { createAuditCorpus, verifyAuditCorpus } from '../domain/audit-corpus.js';
import { AUDIT_OTEL_PROFILE, renderAuditOtel, type AuditOtelFormat } from '../domain/audit-otel.js';
import { AuditOtelProjectionError, verifyAuditOtel } from '../domain/audit-otel-verification.js';
import {
  AuditCorpusLimitError,
  MAX_AUDIT_CORPUS_BYTES,
  MAX_AUDIT_CORPUS_RECORDS,
} from '../domain/audit-corpus-limits.js';
import { assertInitializedReadOnly, resolveRepositoryRoot } from './preconditions.js';

export async function exportAuditCorpus(input: {
  cwd: string;
  sessionIds?: string[];
  all?: boolean;
  output: string;
  format?: 'native' | AuditOtelFormat;
}) {
  if (input.sessionIds && input.sessionIds.length > MAX_AUDIT_CORPUS_RECORDS - 2)
    throw corpusLimitFailure(new AuditCorpusLimitError());
  if (
    Boolean(input.all) === Boolean(input.sessionIds?.length) ||
    (input.sessionIds && new Set(input.sessionIds).size !== input.sessionIds.length)
  ) {
    throw new ThreadloopError('INVALID_ARGUMENT', 'Select --all or unique --session ids.', {
      details: {
        hint: 'Use `audit corpus --all --output <new-file>` or `audit corpus --session <ids...> --output <new-file>`.',
      },
    });
  }
  const repoRoot = await resolveRepositoryRoot(input.cwd);
  await assertInitializedReadOnly(repoRoot);
  const availability = inspectAuditLedgerReadOnly(repoRoot);
  if (availability.schemaVersion !== null && availability.schemaVersion < CURRENT_SCHEMA_VERSION) {
    throw new ThreadloopError(
      'SESSION_SCHEMA_MIGRATION_REQUIRED',
      'Audit corpus requires the current storage schema.',
      {
        details: { hint: 'Run `threadloop init` explicitly, then retry the corpus export.' },
      },
    );
  }
  let corpus: ReturnType<typeof createAuditCorpus>;
  let rendered: ReturnType<typeof renderAuditOtel> | undefined;
  const format = input.format ?? 'native';
  try {
    corpus = createAuditCorpus(readAuditCorpusReadOnly(repoRoot, input.sessionIds), sha256);
    assertAuditCorpusLimits(corpus.content);
    if (format !== 'native') rendered = renderAuditOtel(corpus, format, sha256);
  } catch (cause) {
    if (cause instanceof AuditCorpusLimitError) throw corpusLimitFailure(cause);
    if (cause instanceof StateDatabaseMissingError) {
      throw new ThreadloopError('AUDIT_UNAVAILABLE', 'The state database is missing.', {
        cause,
        details: {
          schema_version: null,
          reason: 'database_missing',
          hint: 'Restore the state database from trusted storage, then retry the corpus export.',
        },
      });
    }
    if (cause instanceof AuditLedgerUnavailableError) {
      throw new ThreadloopError('AUDIT_UNAVAILABLE', cause.message, {
        cause,
        details: {
          schema_version: cause.schemaVersion,
          reason: cause.reason,
          hint: 'Restore the missing audit ledger from trusted storage; run `threadloop init` only for an explicit supported schema migration.',
        },
      });
    }
    throw new ThreadloopError(
      'AUDIT_CORPUS_INVALID',
      "Selected session audit records couldn't form a verified corpus.",
      {
        cause,
        details: {
          reason: cause instanceof Error ? cause.message : String(cause),
          hint: 'Check session ids and `audit verify --session <id>`; restore corrupt or missing ledger records from trusted storage.',
        },
      },
    );
  }
  const output = path.resolve(input.cwd, input.output);
  let publication: Awaited<ReturnType<typeof writeAuditExportExclusive>>;
  try {
    publication = await writeAuditExportExclusive(output, rendered?.content ?? corpus.content);
  } catch (cause) {
    throw new ThreadloopError(
      cause instanceof AuditExportConflictError ? 'AUDIT_EXPORT_CONFLICT' : 'AUDIT_EXPORT_FAILED',
      cause instanceof AuditExportConflictError
        ? cause.message
        : "ThreadLoop couldn't publish the verified audit corpus.",
      {
        cause,
        details: {
          output,
          reason: cause instanceof Error ? cause.message : String(cause),
          hint: 'Inspect any retained staging file named by the error; choose a new writable output path and retry. Existing exports are never overwritten.',
        },
      },
    );
  }
  const result = {
    contract_version: 1 as const,
    output,
    root: rendered?.root ?? corpus.root,
    comparison_unit: 'session' as const,
    session_count: corpus.session_count,
    event_count: corpus.event_count,
    warnings: publication.warnings,
  };
  if (format === 'native') return { ...result, sessions: corpus.manifest.sessions };
  return {
    ...result,
    format,
    profile: AUDIT_OTEL_PROFILE,
    source_root: corpus.root,
    verification: format === 'otel' ? ('projection_only' as const) : ('canonical_records' as const),
  };
}

export async function verifyAuditExport(input: { cwd: string; input: string; root?: string }) {
  const file = path.resolve(input.cwd, input.input);
  try {
    const content = await readAuditCorpusFile(file);
    const output = { contract_version: 1 as const, input: file };
    if (/^\s*\{\s*"resourceLogs"\s*:/.test(content))
      return { ...output, ...verifyAuditOtel(content, sha256, input.root) };
    return { ...output, ...verifyAuditCorpus(content, sha256, input.root) };
  } catch (cause) {
    if (cause instanceof AuditCorpusLimitError) throw corpusLimitFailure(cause);
    throw new ThreadloopError('AUDIT_CORPUS_INVALID', 'Audit corpus verification failed.', {
      cause,
      details: {
        input: file,
        reason: cause instanceof Error ? cause.message : String(cause),
        hint:
          cause instanceof AuditOtelProjectionError
            ? 'Use audit corpus --format otel-verifiable or a native corpus for offline chain verification.'
            : 'Restore the complete original export and compare its root with a separately retained trusted root.',
      },
    });
  }
}

function corpusLimitFailure(cause: AuditCorpusLimitError) {
  return new ThreadloopError('AUDIT_CORPUS_INVALID', cause.message, {
    cause,
    details: {
      max_bytes: MAX_AUDIT_CORPUS_BYTES,
      max_records: MAX_AUDIT_CORPUS_RECORDS,
      hint: 'Export fewer sessions with `audit corpus --session <ids...>` to a new file. For one oversized session, use `audit export --session <id>` for its native chain.',
    },
  });
}
