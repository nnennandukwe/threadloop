import { createHash } from 'node:crypto';
import { accessSync, constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { workflowGuardEvidenceFamily } from '../domain/workflow-action-request.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { z } from 'zod';
import { canonicalJson } from '../domain/canonical-json.js';
import { parseGaapHost } from '../domain/gaap-binding.js';
import { workflowDigest } from '../domain/workflow-selection-types.js';
import type {
  WorkflowGaapAdapter,
  WorkflowGaapEnrollment,
  WorkflowGenesis,
  WorkflowReviewReader,
} from '../domain/workflow-run.js';
import { createInvalidArgumentError, ThreadloopError } from '../contracts/errors.js';
import { hasProtectedReviewReaderPath } from '../adapters/fs/review-reader.js';

const text = z.string().min(1).max(4096).regex(/\S/);
function compileAdapterValidators() {
  const requireSchema = createRequire(import.meta.url);
  const mapping = requireSchema(
    'threadloop-contracts/assets/executor-v0.1/schemas/gaap-mapping-policy.schema.json',
  ) as object;
  const request = requireSchema('threadloop-contracts/assets/executor-v0.1/schemas/executor-request.schema.json') as {
    properties: { request: { properties: { parameters: object } } };
  };
  const ajv = new Ajv2020({ strict: true });
  return {
    mapping: ajv.compile<WorkflowGaapAdapter['mapping_policy']>(mapping),
    parameters: ajv.compile<WorkflowGaapAdapter['parameters']>(request.properties.request.properties.parameters),
  };
}
let compiled: ReturnType<typeof compileAdapterValidators> | undefined;
function adapterValidators() {
  return (compiled ??= compileAdapterValidators());
}
const adapterSchema = z.strictObject({
  schema_version: z.literal('threadloop.workflow-gaap-adapter/1'),
  mapping_policy: z.custom<WorkflowGaapAdapter['mapping_policy']>((value) => adapterValidators().mapping(value)),
  parameters: z.custom<WorkflowGaapAdapter['parameters']>((value) => adapterValidators().parameters(value)),
  executor: z.strictObject({ id: text, incarnation: text }),
  lease_ms: z.number().int().min(1).max(300000),
  execution_policy: z.strictObject({
    id: text,
    retry_safety: z.enum(['reconciliation_required', 'repeatable_after_stop', 'repeatable_with_overlap']),
    max_attempts: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  }),
});
export const reviewReaderSchema = z.strictObject({
  provider: z.literal('qodo'),
  executable: text,
  base_commit: z.string().regex(/^[a-f0-9]{40}$/),
  reviewer_id: text,
});
function invalid(message: string): never {
  throw createInvalidArgumentError(message, {
    reason: 'invalid_gaap_enrollment',
    hint: 'Correct the managed adapter or host configuration and create the run again.',
  });
}

function fileHash(filename: string, executable: boolean, remaining: number) {
  if (!path.isAbsolute(filename) || realpathSync(filename) !== filename)
    invalid('Each enrolled executable or file must use its absolute real path.');
  if (executable) accessSync(filename, constants.X_OK);
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(remaining))
      invalid('An enrolled file exceeds the managed host byte limit or has an unsupported type.');
    const hash = createHash('sha256'),
      chunk = Buffer.allocUnsafe(64 * 1024);
    let consumed = 0;
    while (consumed < Number(before.size)) {
      const read = readSync(fd, chunk, 0, Math.min(chunk.length, Number(before.size) - consumed), null);
      if (!read) invalid('An enrolled file changed during measurement.');
      hash.update(chunk.subarray(0, read));
      consumed += read;
    }
    const after = fstatSync(fd, { bigint: true }),
      current = lstatSync(filename, { bigint: true });
    if (
      after.size !== before.size ||
      after.ctimeNs !== before.ctimeNs ||
      after.mtimeNs !== before.mtimeNs ||
      current.dev !== after.dev ||
      current.ino !== after.ino
    )
      invalid('An enrolled file changed during measurement.');
    return { sha256: hash.digest('hex'), bytes: consumed };
  } finally {
    closeSync(fd);
  }
}
const maxHostBytes = 1024 * 1024 * 1024;
function candidatePaths(host: WorkflowGaapEnrollment['host']) {
  return [
    ...new Set([...host.arguments, ...Object.values(host.environment)].filter((value) => path.isAbsolute(value))),
  ].sort();
}
function contained(root: string, file: string) {
  return file === root || file.startsWith(root + path.sep);
}
function assertEnrollment(enrolled: WorkflowGaapEnrollment, subject: string, reader: WorkflowReviewReader | undefined) {
  const { adapter, host } = enrolled;
  const parsed = adapterSchema.safeParse(adapter);
  if (!parsed.success)
    invalid('The GAAP adapter contains invalid mapping, parameters, executor or execution policy fields.');
  parseGaapHost(host);
  const policy = adapter.mapping_policy.policy;
  if (
    host.workspace !== subject ||
    adapter.parameters.subject_locator !== subject ||
    !path.isAbsolute(host.executable) ||
    Object.keys(host.environment).some(
      (key) => key.startsWith('THREADLOOP_GAAP_') || key.includes('=') || key.includes('\0'),
    ) ||
    [...host.arguments, ...Object.values(host.environment)].some((value) => value.includes('\0')) ||
    adapter.mapping_policy.policy_digest !== workflowDigest(policy) ||
    canonicalJson(policy.capability) !== canonicalJson(adapter.parameters.capability) ||
    canonicalJson(policy.policies) !== canonicalJson(adapter.parameters.policies) ||
    new Set(policy.evidence_mapping.map((item) => item.family)).size !== policy.evidence_mapping.length ||
    new Set(host.verification.keys.map((key) => key.key_id)).size !== host.verification.keys.length ||
    new Set(adapter.parameters.approval_context.map((a) => a.approval_id)).size !==
      adapter.parameters.approval_context.length ||
    adapter.parameters.approval_context.some((a) => a.evidence.evidence_type !== 'approval') ||
    adapter.parameters.required_verification.evidence_types.some(
      (type) => !['artifact', 'command_output', 'verification_attestation'].includes(type),
    ) ||
    adapter.parameters.required_verification.evidence_types.some(
      (type) => !policy.evidence_mapping.some((entry) => entry.evidence_types.includes(type)),
    )
  )
    invalid('The GAAP adapter and host must agree on the subject, mapping, verification and authority.');
  const candidates = candidatePaths(host);
  const names = enrolled.files.map((item) => item.path);
  if (
    enrolled.adapter_digest !== workflowDigest(adapter) ||
    enrolled.host_digest !== workflowDigest(host) ||
    !/^[a-f0-9]{64}$/.test(enrolled.executable_sha256) ||
    canonicalJson(names) !== canonicalJson([...new Set(names)].sort()) ||
    enrolled.files.some(
      (file) => !candidates.includes(file.path) || contained(subject, file.path) || !/^[a-f0-9]{64}$/.test(file.sha256),
    ) ||
    contained(subject, host.executable) ||
    (reader
      ? !/^[a-f0-9]{64}$/.test(enrolled.review_reader_sha256 ?? '') ||
        !path.isAbsolute(reader.executable) ||
        contained(subject, reader.executable)
      : enrolled.review_reader_sha256 !== undefined)
  )
    invalid('The retained GAAP enrollment differs from its immutable configuration or file digests.');
}
export function validateWorkflowGaapEnrollment(
  g: Pick<WorkflowGenesis, 'setup' | 'gaap' | 'subject_root' | 'compiled'>,
) {
  if (g.setup.schema_version === 'threadloop.workflow-setup/1') {
    if (g.gaap !== undefined) invalid("A v1 Workflow Run can't adopt a managed adapter.");
    return;
  }
  if (!g.gaap) invalid('A managed Workflow Run requires its retained GAAP enrollment.');
  assertEnrollment(g.gaap, g.subject_root, g.setup.review_reader);
  const mapping = g.gaap.adapter.mapping_policy.policy;
  const actionIds = new Set(
    g.compiled.graph.required_actions
      .filter((action) => action.authority === 'executor' && action.capability === mapping.action_capability)
      .map((action) => action.id),
  );
  if (!actionIds.size) invalid('The adopted graph has no executor action for the mapped capability.');
  const families = new Set(mapping.evidence_mapping.map((item) => item.family));
  for (const guard of g.compiled.graph.guards) {
    if (!guard.required_actions.some((id) => actionIds.has(id))) continue;
    const family = workflowGuardEvidenceFamily(guard, mapping.action_capability);
    if (family && !families.has(family))
      invalid('The enrolled GAAP mapping lacks an evidence family required by its graph action.');
  }
}
export function adoptWorkflowGaap(
  adapterValue: unknown,
  hostValue: unknown,
  subject: string,
  control: string,
  reader: WorkflowReviewReader | undefined,
): WorkflowGaapEnrollment {
  try {
    const adapter = adapterSchema.parse(adapterValue),
      host = parseGaapHost(hostValue);
    let remaining = maxHostBytes;
    const measure = (filename: string, executable: boolean) => {
      if (contained(subject, filename) || contained(path.join(control, '.threadloop'), filename))
        invalid('The enrolled host files must be outside the subject and control state.');
      const measured = fileHash(filename, executable, remaining);
      remaining -= measured.bytes;
      return measured.sha256;
    };
    const executable_sha256 = measure(host.executable, true);
    if (reader && !hasProtectedReviewReaderPath(reader.executable))
      invalid('Install the Qodo status reader under a path where only the current account and root can change it.');
    const files = candidatePaths(host)
      .filter((name) => {
        const info = lstatSync(name, { throwIfNoEntry: false });
        return info?.isFile() || info?.isSymbolicLink();
      })
      .map((name) => ({ path: name, sha256: measure(name, false) }));
    const entry = {
      adapter,
      adapter_digest: workflowDigest(adapter),
      host,
      host_digest: workflowDigest(host),
      executable_sha256,
      files,
      ...(reader ? { review_reader_sha256: measure(reader.executable, true) } : {}),
    };
    assertEnrollment(entry, subject, reader);
    return entry;
  } catch (cause) {
    if (cause instanceof ThreadloopError) throw cause;
    invalid('The managed host, adapter or pinned files are malformed or unavailable.');
  }
}
function unavailable(cause: unknown): never {
  throw new ThreadloopError('TRANSITION_GUARD_FAILED', 'The enrolled host files are unavailable or have changed.', {
    cause,
    details: { reason: 'managed_producer_changed', hint: 'Restore the enrolled host implementation before retrying.' },
  });
}
export function assertWorkflowGaapExecutable(genesis: WorkflowGenesis): void {
  const entry = genesis.gaap;
  if (!entry) unavailable(undefined);
  try {
    const primary = fileHash(entry.host.executable, true, maxHostBytes);
    let remaining = maxHostBytes - primary.bytes;
    if (primary.sha256 !== entry.executable_sha256) unavailable(undefined);
    const sealed = new Map(entry.files.map((f) => [f.path, f.sha256]));
    for (const name of candidatePaths(entry.host)) {
      const info = lstatSync(name, { throwIfNoEntry: false });
      if (!sealed.has(name) && !info?.isFile() && !info?.isSymbolicLink()) continue;
      const measured = fileHash(name, false, remaining);
      remaining -= measured.bytes;
      if (measured.sha256 !== sealed.get(name)) unavailable(undefined);
    }
  } catch (cause) {
    unavailable(cause);
  }
}
export function assertWorkflowReviewReader(genesis: WorkflowGenesis): WorkflowReviewReader {
  const reader =
    genesis.setup.schema_version === 'threadloop.workflow-setup/2' ? genesis.setup.review_reader : undefined;
  if (!reader || !genesis.gaap?.review_reader_sha256) unavailable(undefined);
  try {
    if (
      hasProtectedReviewReaderPath(reader.executable) &&
      fileHash(reader.executable, true, maxHostBytes).sha256 === genesis.gaap.review_reader_sha256
    )
      return reader;
  } catch (cause) {
    unavailable(cause);
  }
  throw new ThreadloopError('TRANSITION_GUARD_FAILED', 'The enrolled Qodo status reader or its permissions changed.', {
    details: {
      reason: 'managed_producer_changed',
      hint: 'Restore the enrolled reader and restrict write access to its installation before collecting the review.',
    },
  });
}
