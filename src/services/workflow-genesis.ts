import path from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { compileWorkflowProfile, validateGraphBinding } from 'threadloop-contracts/workflow';
import { validateControllerInput } from 'threadloop-contracts/controller';
import { z } from 'zod';
import { readGaapFile, observeGaapWorkspace } from '../adapters/fs/gaap-files.js';
import { sha256 } from '../adapters/crypto/sha256.js';
import { canonicalJson, isPlainObject } from '../domain/canonical-json.js';
import { parseGaapJson } from '../domain/gaap-json.js';
import { gaapObjectDigest } from '../domain/gaap-content.js';
import { bindStoredProofPlan, canonicalizeProofPlan, hasReviewTrustPolicy } from '../domain/proof.js';
import { positiveInteger, canonicalTimestamp, workflowDeadline } from '../domain/validation.js';
import { workflowDigest } from '../domain/workflow-selection-types.js';
import { createInvalidArgumentError, ThreadloopError } from '../contracts/errors.js';
import type { Policy, WorkflowGenesis, WorkflowSetup, WorkflowSources } from '../domain/workflow-run.js';
import { workflowGithubOrigin } from './workflow-observation.js';
import { gaapVerificationPolicy } from '../domain/gaap-binding.js';
import { adoptWorkflowGaap, reviewReaderSchema, validateWorkflowGaapEnrollment } from './workflow-gaap-adapter.js';
import { initialWorkflowHistory } from './workflow-history.js';

const text = z.string().min(1).max(4096);
const id = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const unique = <T extends z.ZodType<string>>(entry: T) =>
  z.array(entry).refine((items) => new Set(items).size === items.length, 'Duplicate entries are invalid.');
const relativePath = text.refine(
  (value) =>
    !value.includes('\\') &&
    !value.includes('\0') &&
    !path.posix.isAbsolute(value) &&
    !path.win32.isAbsolute(value) &&
    value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..' && segment !== '.git'),
  'Expected a normalized repository-relative path.',
);
const legacySetup = z.strictObject({
  schema_version: z.literal('threadloop.workflow-setup/1'),
  subject_workspace: text,
  repository_id: text,
  policy: z.strictObject({
    id: text,
    proof_binding_transition_id: id.nullable(),
    local_gate_ids: unique(id),
    independent_gate_ids: unique(id),
    publication_destination: text.nullable(),
  }),
  proof_plan: text.nullable(),
  trusted_sources: text.nullable(),
  allowed_change_paths: unique(relativePath),
});
const managedSetup = legacySetup.extend({
  schema_version: z.literal('threadloop.workflow-setup/2'),
  gaap: z.strictObject({ adapter: text, host: text }),
  review_reader: reviewReaderSchema.optional(),
});
const setupSchema = z.discriminatedUnion('schema_version', [legacySetup, managedSetup]);
function parseWorkflowSetup(value: unknown, run: string): WorkflowSetup {
  const declared = isPlainObject(value) ? value.schema_version : undefined;
  if (typeof declared === 'string' && /^threadloop\.workflow-setup\/(?:[3-9]|[1-9][0-9]+)$/.test(declared)) {
    throw new ThreadloopError(
      'WORKFLOW_RUNTIME_UNSUPPORTED',
      `Workflow Run ${run} requires setup version ${declared}.`,
      {
        details: {
          reason: 'unsupported_workflow_setup',
          workflow_run_id: run,
          schema_version: declared,
          supported_schema_version: 'threadloop.workflow-setup/2',
          hint: 'Use a ThreadLoop runtime that supports the declared Workflow Run setup version.',
        },
      },
    );
  }
  const parsed = setupSchema.safeParse(value);
  if (!parsed.success)
    throw createInvalidArgumentError('The workflow setup must match threadloop.workflow-setup/1.', {
      reason: 'invalid_workflow_setup',
      issues: parsed.error.issues,
      hint: 'Correct the setup fields or schema version and retry create.',
    });
  return parsed.data as WorkflowSetup;
}

const sourceSchema: z.ZodType<WorkflowSources> = z.strictObject({
  schema_version: z.literal('threadloop.workflow-sources/1'),
  host_producers: unique(z.enum(['local-gate', 'pre-pr-review'])),
  github: z
    .strictObject({
      base_ref: text,
      human_node_id: text,
      preparation_ttl_ms: positiveInteger,
      evidence_ttl_ms: positiveInteger,
    })
    .nullable(),
});
function readInput(filename: string) {
  return new TextDecoder('utf-8', { fatal: true }).decode(readGaapFile(filename, 1_048_576));
}
function readJson(filename: string): unknown {
  return parseGaapJson(readGaapFile(filename, 1_048_576), { maxBytes: 1_048_576 });
}
function fail(message: string): never {
  throw createInvalidArgumentError(message, {
    reason: 'workflow_setup_invalid',
    hint: 'Correct the workflow setup, profile or adopted policy and retry create.',
  });
}
function inside(root: string, dir: string) {
  const name = path.relative(root, dir);
  return name !== '..' && !name.startsWith('..' + path.sep) && !path.isAbsolute(name);
}
function derivePolicy(
  g: Pick<WorkflowGenesis, 'setup' | 'proof_plan' | 'sources' | 'baseline' | 'baseline_branch' | 'gaap'>,
) {
  const { setup, proof_plan: plan, sources, baseline, baseline_branch: branch } = g;
  const { id: policyId, ...declared } = setup.policy;
  const sourcePolicies: WorkflowGenesis['source_policies'] = {};
  function enroll(kind: keyof typeof sourcePolicies, settings: unknown) {
    sourcePolicies[kind] = { id: kind, digest: workflowDigest({ kind, settings }) };
  }
  if (plan) enroll('host-plan', plan.sha256);
  for (const kind of sources?.host_producers ?? [])
    if (kind === 'pre-pr-review' && setup.schema_version === 'threadloop.workflow-setup/2') {
      if (setup.review_reader && g.gaap?.review_reader_sha256)
        enroll(kind, {
          producer: kind,
          version: 2,
          reader: setup.review_reader,
          executable_sha256: g.gaap.review_reader_sha256,
          plan: plan?.sha256 ?? null,
        });
    } else enroll(kind, { producer: kind, version: 1, plan: plan?.sha256 ?? null });
  const authorities: Policy['rules']['authorities'] = [
    { type: 'threadloop', identity: { id: 'threadloop', digest: workflowDigest('threadloop') } },
  ];
  if (sources?.github) {
    if (!plan || !hasReviewTrustPolicy(plan.plan) || plan.plan.contract_version !== 4)
      fail('GitHub sensors require an adopted v4 proof plan.');
    if ([plan.plan.ci, plan.plan.review].some((signer) => signer.source_repository !== setup.repository_id))
      fail('Both signer policies must name the enrolled subject repository.');
    if (!plan.plan.ci.certificate_identity.endsWith('@refs/heads/' + branch))
      fail('The signed gate caller policy must name the bound working branch.');
    enroll('signed-gate', { trust: plan.plan.ci, github: sources.github });
    const reviewPolicy = { trust: plan.plan.review, github: sources.github };
    enroll('signed-review', reviewPolicy);
    if (plan.plan.review.certificate_identity.endsWith('@refs/heads/' + sources.github.base_ref))
      enroll('signed-instruction', reviewPolicy);
    authorities.push({
      type: 'human',
      identity: {
        id: sources.github.human_node_id,
        digest: workflowDigest({ user: sources.github.human_node_id, trust: plan.plan.review }),
      },
    });
  }
  const gates = new Set(plan?.plan.gates.map((gate) => gate.id));
  if ([...declared.local_gate_ids, ...declared.independent_gate_ids].some((gate) => !gates.has(gate)))
    fail('Each configured proof gate must be declared by the adopted plan.');
  if (declared.proof_binding_transition_id !== null && !plan)
    fail('The proof-binding transition requires an adopted proof plan.');
  const rules: Policy['rules'] = {
    ...declared,
    selection: 'threadloop.remedies/0.1',
    proof_plan: plan ? { id: 'proof_plan', digest: plan.sha256 } : null,
    repository_binding: { branch, baseline },
    evidence_policies: [...Object.values(sourcePolicies), ...(g.gaap ? [gaapVerificationPolicy(g.gaap.host)] : [])],
    authorities,
  };
  return { source_policies: sourcePolicies, policy: { id: policyId, digest: workflowDigest(rules), rules } };
}

export function validateWorkflowRunId(run: string, github = false) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(run))
    throw createInvalidArgumentError(
      'Use a run ID of 1 to 160 letters, digits, dots, underscores or hyphens, starting with a letter or digit.',
      { reason: 'invalid_workflow_run_id' },
    );
  if (github && (!/^session_wf_[A-Za-z0-9_-]+$/.test(run) || run.length > 160))
    fail('Sensor-enabled runs require a session_wf_ ID of at most 160 characters.');
}
function assertGenesis(g: WorkflowGenesis) {
  if (workflowDigest(g.setup) !== g.setup_sha256) fail('The retained workflow setup digest differs from its bytes.');
  parseWorkflowSetup(g.setup, g.run_id);
  if (g.sources !== null) sourceSchema.parse(g.sources);
  validateWorkflowRunId(g.run_id, Boolean(g.sources?.github));
  if (
    !canonicalTimestamp.safeParse(g.created_at).success ||
    !path.isAbsolute(g.subject_root) ||
    !g.baseline_branch ||
    g.baseline.kind !== 'repository' ||
    g.baseline.repository_id !== g.setup.repository_id ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(g.baseline.revision) ||
    gaapObjectDigest(g.baseline_manifest) !== 'sha256:' + g.baseline.content_digest ||
    (g.sources === null) !== (g.setup.trusted_sources === null) ||
    (g.proof_plan === null) !== (g.setup.proof_plan === null) ||
    workflowDigest(g.setup.allowed_change_paths) !== g.change_scope_digest ||
    canonicalJson(g.compiled.graph) !== g.graph_json ||
    sha256(g.graph_json) !== g.compiled.graph_digest
  )
    fail('The workflow genesis fields disagree with their retained binding.');
  const github = g.sources?.github;
  if (github) {
    for (const field of ['preparation_ttl_ms', 'evidence_ttl_ms'] as const) {
      if (!workflowDeadline(g.created_at, github[field])) {
        throw createInvalidArgumentError(`The configured ${field} exceeds the Workflow Run timestamp range.`, {
          reason: 'invalid_workflow_deadline',
          field,
          hint: 'Shorten the configured lifetime so its deadline falls in year 9999 or earlier, then retry create.',
        });
      }
    }
  }
  if (g.proof_plan) {
    const bound = bindStoredProofPlan(g.proof_plan, sha256);
    if (
      'problem' in bound ||
      canonicalJson(bound.plan) !== canonicalJson(g.proof_plan) ||
      g.proof_plan.baselineBranch !== g.baseline_branch ||
      g.proof_plan.baselineHeadSha !== g.baseline.revision ||
      g.proof_plan.createdAt !== g.created_at
    )
      fail('The adopted proof plan disagrees with its baseline or canonical bytes.');
  }
  validateWorkflowGaapEnrollment(g);
  if (
    g.setup.schema_version === 'threadloop.workflow-setup/2' &&
    g.setup.review_reader &&
    !g.sources?.host_producers.includes('pre-pr-review')
  )
    fail('The managed review reader requires a declared pre-PR review source.');
  const derived = derivePolicy(g);
  if (
    canonicalJson(derived.policy) !== canonicalJson(g.policy) ||
    canonicalJson(derived.source_policies) !== canonicalJson(g.source_policies)
  )
    fail('The workflow policy disagrees with its enrolled sources or declared rules.');
  const graph = validateGraphBinding(
    { graph_schema_version: '0.1', graph_digest: g.compiled.graph_digest },
    g.compiled,
  );
  if (!graph.ok) fail('The retained graph is invalid.');
  const result = validateControllerInput({
    schema_version: '0.1',
    compiled_graph: g.compiled,
    binding: {
      workflow_run_id: g.run_id,
      graph_schema_version: '0.1',
      graph_digest: g.compiled.graph_digest,
      source_state: g.compiled.graph.initial_state,
      state_version: 0,
      subject: g.baseline,
    },
    history: { ...initialWorkflowHistory(g), digest: g.setup_sha256 },
    policy: g.policy,
    observation: {
      id: 'genesis',
      state_version: 0,
      status: 'verified',
      subject: g.baseline,
      valid_until: null,
      repository: {
        branch: g.baseline_branch,
        clean: true,
        basis: null,
        change_scope: 'unknown',
        relationship: 'unknown',
      },
    },
    available_capabilities: [],
    receipts: [],
    invalidated_claims: [],
    existing_requests: [],
    execution: { status: 'idle' },
    evaluation_time: g.created_at,
  });
  if (!result.ok)
    throw createInvalidArgumentError('The graph and workflow policy are incompatible.', {
      diagnostics: result.diagnostics,
    });
}
export function validateWorkflowGenesis(genesis: WorkflowGenesis): void {
  try {
    assertGenesis(genesis);
  } catch (cause) {
    if (cause instanceof ThreadloopError && cause.code === 'WORKFLOW_RUNTIME_UNSUPPORTED') throw cause;
    throw new ThreadloopError('STATE_CORRUPTED', 'The retained Workflow Run genesis is invalid.', {
      cause,
      details: { reason: 'workflow_genesis_invalid', hint: 'Restore the run from trusted storage.' },
    });
  }
}
export function workflowCreateRequestJson(
  input: Pick<WorkflowGenesis, 'run_id' | 'compiled' | 'setup' | 'subject_root' | 'sources' | 'gaap'> & {
    proof_plan: { json: string } | null;
  },
): string {
  return canonicalJson({
    run: input.run_id,
    graph: input.compiled.graph,
    setup: input.setup,
    subject_root: input.subject_root,
    proof_plan: input.proof_plan?.json ?? null,
    sources: input.sources,
    ...(input.gaap ? { gaap: input.gaap } : {}),
  });
}

export function prepareWorkflowGenesis(
  cwd: string,
  run: string,
  profile: string,
  setupFile: string,
  controlRoot = cwd,
) {
  const graph = compileWorkflowProfile(readInput(path.resolve(cwd, profile)));
  if (!graph.ok)
    throw createInvalidArgumentError('The workflow profile is invalid.', { diagnostics: graph.diagnostics });
  const compiled = graph.value;
  const filename = path.resolve(cwd, setupFile);
  const resolveInput = (name: string) => path.resolve(path.dirname(filename), name);
  const setup = parseWorkflowSetup(readJson(filename), run);
  const subjectRoot = resolveInput(setup.subject_workspace);
  const control = realpathSync(controlRoot);
  if (inside(subjectRoot, control) || inside(control, subjectRoot))
    fail('The control and subject repositories must occupy separate directories.');
  const sources = setup.trusted_sources ? sourceSchema.parse(readJson(resolveInput(setup.trusted_sources))) : null;
  validateWorkflowRunId(run, Boolean(sources?.github));
  const plan = setup.proof_plan
    ? canonicalizeProofPlan(readJson(resolveInput(setup.proof_plan)), sha256, {
        requireReviewPolicy: Boolean(sources?.github),
        requireCiPolicy: Boolean(sources?.github),
      })
    : null;
  const gaap =
    setup.schema_version === 'threadloop.workflow-setup/2'
      ? adoptWorkflowGaap(
          readJson(resolveInput(setup.gaap.adapter)),
          readJson(resolveInput(setup.gaap.host)),
          subjectRoot,
          control,
          setup.review_reader,
        )
      : undefined;
  const enrollment = gaap ? { gaap } : {};
  const graphJson = canonicalJson(compiled.graph);
  const requestJson = workflowCreateRequestJson({
    run_id: run,
    compiled,
    setup,
    subject_root: subjectRoot,
    ...enrollment,
    proof_plan: plan,
    sources,
  });
  return {
    requestJson,
    build(now: string): WorkflowGenesis {
      const physical = observeGaapWorkspace(subjectRoot);
      if (!physical.clean || !physical.branch) fail('The initial subject requires a clean, named branch.');
      if (
        sources?.github &&
        (workflowGithubOrigin(subjectRoot) !== setup.repository_id || physical.revision.length !== 40)
      )
        fail('The physical GitHub origin and revision must match the enrolled repository.');
      for (const gate of plan?.plan.gates ?? []) {
        for (const item of [gate, ...(gate.setup ?? [])]) {
          const dir = realpathSync(path.resolve(subjectRoot, item.working_directory));
          if (!inside(subjectRoot, dir) || !statSync(dir).isDirectory())
            fail('Every proof working directory must belong to the subject.');
        }
      }
      const baseline = {
        kind: 'repository' as const,
        repository_id: setup.repository_id,
        revision: physical.revision,
        content_digest: physical.digest,
      };
      const record = {
        run_id: run,
        compiled,
        graph_json: graphJson,
        ...enrollment,
        setup,
        setup_sha256: workflowDigest(setup),
        change_scope_digest: workflowDigest(setup.allowed_change_paths),
        subject_root: subjectRoot,
        baseline,
        baseline_manifest: physical.manifest,
        baseline_branch: physical.branch,
        sources,
        proof_plan: plan
          ? { ...plan, baselineBranch: physical.branch, baselineHeadSha: physical.revision, createdAt: now }
          : null,
        created_at: now,
      };
      const genesis = { ...record, ...derivePolicy(record) };
      assertGenesis(genesis);
      return genesis;
    },
  };
}
