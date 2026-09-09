import { canonicalJson } from '../../src/domain/canonical-json.js';
import { sha256 } from '../../src/adapters/crypto/sha256.js';

/** Supplied by the host, backed by admissions outside the executor-controlled JSON. */
export interface ExecutionAuthority {
  isAdmitted(digest: string): boolean;
}

export type ExecutionAdmission =
  | { kind: 'create'; context: unknown; request: unknown; policy: unknown }
  | { kind: 'operation'; execution_digest: string; context: unknown; operation: unknown }
  | { kind: 'projection'; execution_digest: string; snapshot: unknown };

/** The digest identifies an admission; only the independent authority can establish trust. */
export function executionAdmissionDigest(admission: ExecutionAdmission): string {
  return sha256(canonicalJson({ domain: 'threadloop.execution-admission.v0.1', admission }));
}

export function isExecutionAdmitted(authority: ExecutionAuthority, admission: ExecutionAdmission): boolean {
  try {
    return authority.isAdmitted(executionAdmissionDigest(admission)) === true;
  } catch {
    return false;
  }
}
