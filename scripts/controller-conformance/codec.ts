import { canonicalExecutorJson, parseExecutorMessage } from '../executor-contract/codec.js';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import type { ValidationResult } from '../workflow-graph/contracts.js';

function translate<T>(result: ValidationResult<T>): ValidationResult<T> {
  return result.ok
    ? result
    : {
        ok: false,
        diagnostics: result.diagnostics.map((item) => ({
          ...item,
          code: item.code.replace('EXECUTOR_', 'CONFORMANCE_'),
          recovery:
            'Restore the exact conformance document and supported versions; do not repair bytes during validation.',
        })),
      };
}

export function canonicalConformanceJson(value: unknown): ValidationResult<string> {
  return translate(canonicalExecutorJson(value));
}

export function parseConformanceMessage(bytes: Uint8Array): ValidationResult<unknown> {
  return translate(parseExecutorMessage(bytes));
}

/** Internal digest helper: public callers validate bounded JSON before hashing. */
export function conformanceDigest(value: unknown): string {
  const result = canonicalConformanceJson(value);
  if (!result.ok) throw new Error(result.diagnostics[0]!.message);
  return sha256(result.value);
}
