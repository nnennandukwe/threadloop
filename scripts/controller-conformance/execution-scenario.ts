import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { createExecutionJournal } from 'threadloop-contracts/execution';
import type { OperationResult } from 'threadloop-contracts/execution';
import schema from 'threadloop-contracts/assets/controller-conformance-v0.1/schemas/execution-scenario.schema.json' with { type: 'json' };
import { ScenarioJournal } from './scenario-journal.js';

interface Scenario {
  initial: { context: unknown; request: unknown; policy: unknown };
  steps: { context: unknown; operation: unknown }[];
  admitted_digests: string[];
  projection_snapshot: unknown;
}
type Diagnostic = { code: string; path: string; identifier: string | null };
const scenarioSchema = z.fromJSONSchema(schema as z.core.JSONSchema.JSONSchema) as z.ZodType<Scenario>;
function invalid(diagnostics: Diagnostic[]) {
  return {
    status: 'invalid' as const,
    diagnostics: diagnostics.map(({ code, path, identifier }) => ({ code, path, identifier })),
  };
}

export function runExecutionScenario(input: unknown) {
  const parsed = scenarioSchema.safeParse(input);
  if (!parsed.success)
    return invalid(
      parsed.error.issues.map((issue) => ({
        code: 'SCHEMA_INVALID',
        path:
          '$' + issue.path.map((part) => (typeof part === 'number' ? '[' + part + ']' : '.' + String(part))).join(''),
        identifier: null,
      })),
    );
  const { initial, steps, admitted_digests, projection_snapshot } = parsed.data;
  const admitted = new Set(admitted_digests);
  if (admitted.size !== admitted_digests.length)
    return invalid([{ code: 'DUPLICATE_ADMISSION', path: '$', identifier: null }]);
  const authority = { isAdmitted: (digest: string) => admitted.has(digest) };
  const created = createExecutionJournal(initial.context, initial.request, initial.policy, authority);
  if (!created.ok) return invalid(created.diagnostics);
  const directory = mkdtempSync(path.join(tmpdir(), 'threadloop-scenario-'));
  try {
    const journal = new ScenarioJournal(path.join(directory, 'journal.sqlite'), authority);
    journal.initialize(created.value);
    const results: (Omit<OperationResult, 'recovery'> & { replayed: boolean })[] = [];
    for (const step of steps) {
      const applied = journal.apply(step.context, step.operation);
      if (!applied.ok) return invalid(applied.diagnostics);
      const { disposition, code, revision, claim, attempt_id } = applied.value.result;
      results.push({ disposition, code, revision, claim, attempt_id, replayed: applied.value.replayed });
    }
    const final = journal.project(projection_snapshot);
    if (!final.ok) return invalid(final.diagnostics);
    const { projection, controller } = final.value;
    return {
      status: 'execution' as const,
      steps: results,
      projection: {
        revision: projection.revision,
        request_status: projection.request_status,
        claims: projection.claims.map(({ id, version, status, attempt_id }) => ({ id, version, status, attempt_id })),
        attempts: projection.attempts.map(({ id, claim, status, effect, receipt_id }) => ({
          id,
          claim,
          status,
          effect,
          receipt_id,
        })),
        receipts: projection.receipts.map(({ envelope, result }) => ({
          id: envelope.receipt.id,
          receipt_digest: envelope.receipt_digest,
          code: result.code,
        })),
        conflicts: projection.conflicts.map(
          ({ namespace, identity, original_digest, incoming_digest, resolved_by }) => ({
            namespace,
            identity,
            original_digest,
            incoming_digest,
            resolved_by,
          }),
        ),
        controller,
      },
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
