import type { z } from 'zod';
import { digest, same, validateShape, withRecovery, type ValidationResult } from '../contract-kernel/kernel.js';
import { compileWorkflowProfile } from '../workflow-graph/compiler.js';
import { validateControllerInput } from '../controller-contract/validation.js';
import { validateControllerDecision } from '../controller-contract/decision.js';
import {
  createExecutionJournal,
  applyExecutionOperation,
  projectControllerExecution,
  replayExecutionJournal,
} from '../execution-contract/model.js';
import { canonicalConformanceJson, conformanceDigest, parseConformanceMessage } from './codec.js';
import {
  compatibilitySchema,
  executionScenarioSchema,
  fixtureSchema,
  manifestSchema,
  requestSchema,
  responseSchema,
  subjectSchema,
  versions,
  requiredCoverage,
  type CaseResult,
  type Fixture,
  type Manifest,
  type SubjectRequest,
  type SubjectResponse,
} from './contracts.js';

const { invalid: failure } = withRecovery(
  'Restore the named contract artifact or intentionally update its version and reviewed digest; rerun npm run spec:conformance:check.',
);

function parse<T>(schema: z.ZodType<T>, value: unknown): ValidationResult<T> {
  const bytes = canonicalConformanceJson(value);
  return bytes.ok ? validateShape(schema, value) : bytes;
}

function diagnostics(result: Extract<ValidationResult<unknown>, { ok: false }>): CaseResult {
  return {
    status: 'invalid',
    diagnostics: result.diagnostics.map(({ code, path, identifier }) => ({ code, path, identifier })),
  };
}

/** Replay accepted #106 development semantics only; this is not a controller selector or process subject. */
function executionResult(input: unknown): ValidationResult<CaseResult> {
  const scenario = parse(executionScenarioSchema, input);
  if (!scenario.ok) return scenario;
  const { initial, steps, projection_snapshot: snapshot, admitted_digests: admitted } = scenario.value;
  const admittedDigests = new Set(admitted);
  if (admittedDigests.size !== admitted.length)
    return failure('DUPLICATE_ADMISSION', 'Synthetic admission digests must be unique.');
  const authority = { isAdmitted: (digest: string) => admittedDigests.has(digest) };
  const created = createExecutionJournal(initial.context, initial.request, initial.policy, authority);
  if (!created.ok) return { ok: true, value: diagnostics(created) };
  let journal = created.value;
  const results = [];
  for (const step of steps) {
    const applied = applyExecutionOperation(journal, step.context, step.operation, authority);
    if (!applied.ok) return { ok: true, value: diagnostics(applied) };
    journal = applied.value.journal;
    const { disposition, code, revision, claim, attempt_id } = applied.value.result;
    results.push({ disposition, code, revision, claim, attempt_id, replayed: applied.value.replayed });
  }
  const state = replayExecutionJournal(journal, authority);
  if (!state.ok) return { ok: true, value: diagnostics(state) };
  const controller = projectControllerExecution(journal, snapshot, authority);
  if (!controller.ok) return { ok: true, value: diagnostics(controller) };
  const value = state.value;
  return {
    ok: true,
    value: {
      status: 'execution',
      steps: results,
      projection: {
        revision: value.revision,
        request_status: value.request_status,
        claims: value.claims.map(({ id, version, status, attempt_id }) => ({ id, version, status, attempt_id })),
        attempts: value.attempts.map(({ id, claim, status, effect, receipt_id }) => ({
          id,
          claim,
          status,
          effect,
          receipt_id,
        })),
        receipts: value.receipts.map(({ envelope, result }) => ({
          id: envelope.receipt.id,
          receipt_digest: envelope.receipt_digest,
          code: result.code,
        })),
        conflicts: value.conflicts.map(({ namespace, identity, original_digest, incoming_digest, resolved_by }) => ({
          namespace,
          identity,
          original_digest,
          incoming_digest,
          resolved_by,
        })),
        controller: controller.value,
      },
    },
  };
}

/** Checks available consistency evidence. Never claims a candidate wins selection. */
function validateResult(
  operation: SubjectRequest['request']['operation'],
  input: unknown,
  result: CaseResult,
): ValidationResult<true> {
  if (operation === 'compile_graph') {
    const compiled = compileWorkflowProfile(JSON.stringify(input));
    const actual: CaseResult = compiled.ok
      ? { status: 'compiled', compiled_graph: compiled.value }
      : diagnostics(compiled);
    return same(actual, result)
      ? { ok: true, value: true }
      : failure('GRAPH_RESULT_MISMATCH', 'Result differs from accepted graph compilation semantics.');
  }
  if (operation === 'execution_scenario') {
    const actual = executionResult(input);
    if (!actual.ok) return actual;
    return same(actual.value, result)
      ? { ok: true, value: true }
      : failure('EXECUTION_RESULT_MISMATCH', 'Result differs from accepted execution journal semantics.');
  }
  const snapshot = validateControllerInput(input);
  if (!snapshot.ok)
    return same(diagnostics(snapshot), result)
      ? { ok: true, value: true }
      : failure('INPUT_RESULT_MISMATCH', 'Invalid input requires its validation diagnostics.');
  if (result.status !== 'decision')
    return failure('RESULT_KIND_MISMATCH', 'Valid controller input requires a Controller Decision.');
  const { decision, decision_digest } = result.decision;
  if (digest(decision) !== decision_digest || decision.input_digest !== digest(snapshot.value))
    return failure('DOMAIN_DIGEST_MISMATCH', 'Controller decision must bind its exact payload and complete input.');
  const candidate = validateControllerDecision(snapshot.value, result.decision);
  if (candidate.ok) return { ok: true, value: true };
  // Explicit proof gap, not a passing selector: retained normative cases require a future subject.
  if (candidate.diagnostics.every((item) => item.code === 'SELECTION_PROOF_REQUIRED')) return { ok: true, value: true };
  return candidate;
}

function validateManifest(value: unknown): ValidationResult<Manifest> {
  const parsed = parse(manifestSchema, value);
  if (!parsed.ok) return parsed;
  if (conformanceDigest(parsed.value.manifest) !== parsed.value.corpus_digest)
    return failure('CORPUS_DIGEST_MISMATCH', 'Manifest content differs from its corpus digest.');
  const entries = parsed.value.manifest.entries;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (entry.path !== `fixtures/${entry.id}.json` || (index > 0 && entries[index - 1]!.id >= entry.id))
      return failure('INVALID_INVENTORY', 'Manifest identities must be unique, sorted, and match their fixture paths.');
  }
  return parsed;
}

function validateFixture(value: unknown): ValidationResult<Fixture> {
  const parsed = parse(fixtureSchema, value);
  if (!parsed.ok) return parsed;
  const fixture = parsed.value;
  if (new Set(fixture.coverage).size !== fixture.coverage.length)
    return failure('DUPLICATE_COVERAGE', 'Coverage tags must be unique.');
  if (
    (fixture.operation === 'compile_graph' && fixture.semantic_check !== 'graph') ||
    (fixture.operation === 'execution_scenario' && fixture.semantic_check !== 'execution') ||
    (fixture.operation === 'decide' && !['candidate', 'selection_pending'].includes(fixture.semantic_check))
  )
    return failure('COVERAGE_KIND_MISMATCH', 'Semantic check must describe the operation actually checked.');
  const pending =
    fixture.expected.status === 'decision' &&
    fixture.expected.decision.decision.outcome === 'blocked' &&
    fixture.expected.decision.decision.reasons.some((reason) =>
      ['AMBIGUOUS_REMEDY', 'NO_APPLICABLE_REMEDY'].includes(reason.code),
    );
  if (pending !== (fixture.semantic_check === 'selection_pending'))
    return failure(
      'SELECTION_COVERAGE_MISMATCH',
      'Unimplemented selection expectations must be explicitly marked selection_pending.',
    );
  const valid = validateResult(fixture.operation, fixture.input, fixture.expected);
  return valid.ok ? parsed : valid;
}

export function validateCorpus(
  manifest: unknown,
  fixtures: Readonly<Record<string, unknown>>,
  compatibility: unknown,
): ValidationResult<{ manifest: Manifest; fixtures: Fixture[] }> {
  const parsed = validateManifest(manifest);
  if (!parsed.ok) return parsed;
  const compatible = parse(compatibilitySchema, compatibility);
  if (!compatible.ok) return compatible;
  const names = compatible.value.contracts.map((contract) => contract.name);
  if (
    new Set(names).size !== 4 ||
    compatible.value.contracts.some(
      (contract) => new Set(contract.schemas.map((schema) => schema.path)).size !== contract.schemas.length,
    )
  )
    return failure(
      'COMPATIBILITY_INVENTORY',
      'Compatibility descriptor must identify each contract and schema exactly once.',
    );
  if (conformanceDigest(compatible.value) !== parsed.value.manifest.compatibility_digest)
    return failure('COMPATIBILITY_DIGEST_MISMATCH', 'Manifest must bind the exact compatibility descriptor.');
  if (fixtures === null || typeof fixtures !== 'object' || Array.isArray(fixtures))
    return failure('INVALID_INVENTORY', 'Fixtures must be a map from corpus-relative paths to JSON documents.');
  const bounded = canonicalConformanceJson(fixtures);
  if (!bounded.ok) return bounded;
  const entries = parsed.value.manifest.entries;
  if (!same(Object.keys(fixtures).sort(), entries.map((entry) => entry.path).sort()))
    return failure('INVALID_INVENTORY', 'Every fixture must be listed exactly once, without missing or extra files.');
  const validated: Fixture[] = [];
  for (const entry of entries) {
    const checked = validateFixture(fixtures[entry.path]);
    if (!checked.ok)
      return {
        ok: false,
        diagnostics: checked.diagnostics.map((item) => ({ ...item, path: `${entry.path}:${item.path}` })),
      };
    const fixture = checked.value;
    if (
      fixture.id !== entry.id ||
      fixture.operation !== entry.operation ||
      conformanceDigest(fixture.input) !== entry.input_digest ||
      conformanceDigest(fixture) !== entry.fixture_digest
    )
      return failure(
        'FIXTURE_DIGEST_MISMATCH',
        'Fixture identity, input, or complete content differs from the manifest.',
        entry.path,
      );
    validated.push(fixture);
  }
  const coverage = new Set(validated.flatMap((fixture) => fixture.coverage));
  if (requiredCoverage.some((category) => !coverage.has(category)))
    return failure('MISSING_COVERAGE', 'Corpus must cover every required #108 scenario.');
  const outcomes = new Set(
    validated.flatMap((fixture) =>
      fixture.expected.status === 'decision' ? [fixture.expected.decision.decision.outcome] : [],
    ),
  );
  if (outcomes.size !== 6) return failure('MISSING_OUTCOME', 'Corpus must cover all six Controller Decision outcomes.');
  return { ok: true, value: { manifest: parsed.value, fixtures: validated } };
}

export function buildSubjectRequest(fixtureValue: unknown, manifestValue: unknown): ValidationResult<SubjectRequest> {
  const bound = bindRequest(fixtureValue, manifestValue);
  return bound.ok ? { ok: true, value: bound.value.request } : bound;
}

function bindRequest(
  fixtureValue: unknown,
  manifestValue: unknown,
): ValidationResult<{ fixture: Fixture; request: SubjectRequest }> {
  const manifest = validateManifest(manifestValue);
  if (!manifest.ok) return manifest;
  const parsed = validateFixture(fixtureValue);
  if (!parsed.ok) return parsed;
  const fixture = parsed.value;
  const entry = manifest.value.manifest.entries.find((item) => item.id === fixture.id);
  if (
    !entry ||
    entry.operation !== fixture.operation ||
    entry.fixture_digest !== conformanceDigest(fixture) ||
    entry.input_digest !== conformanceDigest(fixture.input)
  )
    return failure('FIXTURE_DIGEST_MISMATCH', 'Request construction requires an intact manifest-listed fixture.');
  const request: SubjectRequest['request'] = {
    protocol: versions.protocol,
    schema: versions.request_schema,
    fixture_schema: versions.fixture_schema,
    canonicalization: versions.canonicalization,
    digest_profile: versions.digest_profile,
    corpus_digest: manifest.value.corpus_digest,
    case_id: fixture.id,
    operation: fixture.operation,
    input: structuredClone(fixture.input),
    input_digest: entry.input_digest,
  };
  return { ok: true, value: { fixture, request: { request, request_digest: conformanceDigest(request) } } };
}

export function validateSubjectResponse(
  bytes: Uint8Array,
  requestValue: unknown,
  expectedSubject: unknown,
): ValidationResult<SubjectResponse> {
  const request = parse(requestSchema, requestValue);
  if (!request.ok) return request;
  if (
    conformanceDigest(request.value.request) !== request.value.request_digest ||
    conformanceDigest(request.value.request.input) !== request.value.request.input_digest
  )
    return failure('REQUEST_DIGEST_MISMATCH', 'Request must bind its exact input and complete payload.');
  const subject = parse(subjectSchema, expectedSubject);
  if (!subject.ok) return subject;
  const decoded = parseConformanceMessage(bytes);
  if (!decoded.ok) return decoded;
  const response = parse(responseSchema, decoded.value);
  if (!response.ok) return response;
  const payload = response.value.response;
  if (conformanceDigest(payload) !== response.value.response_digest)
    return failure('RESPONSE_DIGEST_MISMATCH', 'Response content differs from its digest.');
  if (payload.request_digest !== request.value.request_digest)
    return failure('REQUEST_BINDING_MISMATCH', 'Response belongs to another request.');
  if (!same(payload.subject, subject.value))
    return failure('SUBJECT_MISMATCH', 'Declared subject differs from the harness-pinned identity.');
  const result = validateResult(request.value.request.operation, request.value.request.input, payload.result);
  return result.ok ? response : result;
}

function machineResult(result: CaseResult): unknown {
  if (result.status !== 'decision') return result;
  // Compare the payload; its enclosing decision_digest also covers informational prose.
  const decision = result.decision.decision;
  if (decision.outcome !== 'blocked') return result;
  return {
    status: result.status,
    decision: {
      ...decision,
      reasons: decision.reasons.map((reason) =>
        Object.fromEntries(Object.entries(reason).filter(([key]) => key !== 'message' && key !== 'recovery')),
      ),
    },
  };
}

export function compareCaseResult(
  fixtureValue: unknown,
  manifestValue: unknown,
  requestValue: unknown,
  bytes: Uint8Array,
  expectedSubject: unknown,
): ValidationResult<true> {
  const bound = bindRequest(fixtureValue, manifestValue);
  if (!bound.ok) return bound;
  const { fixture } = bound.value;
  const response = validateSubjectResponse(bytes, requestValue, expectedSubject);
  if (!response.ok) return response;
  if (!same(bound.value.request, requestValue))
    return failure('FIXTURE_BINDING_MISMATCH', 'Comparison fixture and manifest must match the exact request.');
  const request = requestSchema.parse(requestValue).request;
  if (request.case_id !== fixture.id || request.operation !== fixture.operation || !same(request.input, fixture.input))
    return failure('FIXTURE_BINDING_MISMATCH', 'Comparison requires the same case and input as the validated request.');
  return same(machineResult(response.value.response.result), machineResult(fixture.expected))
    ? { ok: true, value: true }
    : failure('RESULT_MISMATCH', 'Validated response differs from the harness-held expected machine result.');
}
