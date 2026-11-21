import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from '../adapters/crypto/sha256.js';
import { AuditExportConflictError, writeAuditExportExclusive } from '../adapters/fs/audit-export.js';
import {
  CURRENT_SCHEMA_VERSION,
  inspectAuditLedgerReadOnly,
  readAuditCorpusReadOnly,
  AuditLedgerUnavailableError,
} from '../adapters/fs/sqlite-store.js';
import { ThreadloopError } from '../contracts/errors.js';
import { createAuditCorpus, verifyAuditCorpus } from '../domain/audit-corpus.js';
import { assertInitializedReadOnly, resolveRepositoryRoot } from './preconditions.js';

export async function exportAuditCorpus(input: { cwd: string; sessionIds?: string[]; all?: boolean; output: string }) {
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
  try {
    corpus = createAuditCorpus(readAuditCorpusReadOnly(repoRoot, input.sessionIds), sha256);
  } catch (cause) {
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
    publication = await writeAuditExportExclusive(output, corpus.content);
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
  return {
    contract_version: 1 as const,
    output,
    root: corpus.root,
    comparison_unit: 'session' as const,
    session_count: corpus.session_count,
    event_count: corpus.event_count,
    warnings: publication.warnings,
    sessions: corpus.manifest.sessions,
  };
}

export async function verifyAuditExport(input: { cwd: string; input: string; root?: string }) {
  const file = path.resolve(input.cwd, input.input);
  try {
    const bytes = await readFile(file);
    const content = bytes.toString('utf8');
    if (!Buffer.from(content, 'utf8').equals(bytes)) throw new Error('Export contains invalid UTF-8 bytes.');
    const verified = verifyAuditCorpus(content, sha256, input.root);
    return { contract_version: 1 as const, input: file, ...verified };
  } catch (cause) {
    throw new ThreadloopError('AUDIT_CORPUS_INVALID', 'Audit corpus verification failed.', {
      cause,
      details: {
        input: file,
        reason: cause instanceof Error ? cause.message : String(cause),
        hint: 'Restore the complete original export and compare its root with a separately retained trusted root.',
      },
    });
  }
}
