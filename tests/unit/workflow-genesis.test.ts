import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ThreadloopError } from '../../src/contracts/errors.js';
import { captureError } from '../fixtures/receipts.js';
import type { WorkflowSources } from '../../src/domain/workflow-run.js';
import { workflowDigest } from '../../src/domain/workflow-selection-types.js';
import { prepareWorkflowGenesis, validateWorkflowGenesis } from '../../src/services/workflow-genesis.js';
import { cleanupTemporaryState, makeCommittedRepo, makeTempDir, proofPlan } from '../helpers/session.js';
import { governedProfile, governedWorkflowFixture } from '../helpers/workflow-run.js';

const profile = fileURLToPath(new URL('../fixtures/workflow/quote.yaml', import.meta.url));
const now = '2026-11-21T00:00:00.000Z';
describe('workflow genesis', () => {
  afterEach(cleanupTemporaryState);

  it('requires a clean physical subject when adopting the initial binding', async () => {
    const control = await makeTempDir();
    const subject = await makeCommittedRepo({ branch: 'quote', remote: null });
    await writeFile(
      path.join(control, 'setup.json'),
      JSON.stringify({
        schema_version: 'threadloop.workflow-setup/1',
        subject_workspace: path.relative(control, subject),
        repository_id: 'quote-project',
        policy: {
          id: 'local',
          proof_binding_transition_id: null,
          local_gate_ids: [],
          independent_gate_ids: [],
          publication_destination: null,
        },
        proof_plan: null,
        trusted_sources: null,
        allowed_change_paths: [],
      }),
    );
    const prepared = prepareWorkflowGenesis(control, 'quote', profile, 'setup.json');
    await writeFile(path.join(subject, 'README.md'), 'a change after preparing the request');
    expect(() => prepared.build(now)).toThrow(/clean/i);
  });

  it('adopts a governed run’s declared gates, signer policies and named reviewer from its input files', async () => {
    const { control } = await governedWorkflowFixture();
    const prepared = prepareWorkflowGenesis(control, 'session_wf_governed', governedProfile, 'setup.json');
    const genesis = prepared.build(now);
    expect(genesis.proof_plan?.plan.gates.map((gate) => gate.id)).toEqual(['check']);
    expect(genesis.policy.rules.local_gate_ids).toEqual(['check']);
    expect(genesis.policy.rules.proof_plan?.digest).toBe(genesis.proof_plan?.sha256);
    const named = genesis.policy.rules.authorities.find((authority) => authority.type === 'human');
    expect(named?.identity.id).toBe('github_user');
    expect(named?.identity.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(genesis.source_policies['signed-review']).toBeDefined();
    expect(genesis.source_policies['signed-instruction']).toBeDefined();
  });
  it('rejects repeated setup keys and checks the full control root from a nested invocation', async () => {
    const { control, setup } = await governedWorkflowFixture();
    const nested = path.join(control, 'docs');
    await mkdir(nested);
    const duplicate = JSON.stringify(setup).replace('"repository_id":', '"repository_id":"first","repository_id":');
    await writeFile(path.join(control, 'setup.json'), duplicate);
    expect(() =>
      prepareWorkflowGenesis(nested, 'session_wf_governed', governedProfile, '../setup.json', control),
    ).toThrow();
    await writeFile(
      path.join(control, 'setup.json'),
      JSON.stringify({ ...setup, subject_workspace: path.join(control, 'subject') }),
    );
    expect(() =>
      prepareWorkflowGenesis(nested, 'session_wf_governed', governedProfile, '../setup.json', control),
    ).toThrow(/separate directories/);
  });
  it('rejects undeclared proof gates and altered retained change-scope authority', async () => {
    const { control, setup } = await governedWorkflowFixture();
    const prepared = prepareWorkflowGenesis(control, 'session_wf_governed', governedProfile, 'setup.json');
    const genesis = prepared.build(now);
    const changed = structuredClone(genesis);
    changed.change_scope_digest = '0'.repeat(64);
    expect(() => validateWorkflowGenesis(changed)).toThrow(/retained Workflow Run genesis/);
    await writeFile(
      path.join(control, 'setup.json'),
      JSON.stringify({ ...setup, policy: { ...setup.policy, independent_gate_ids: ['other'] } }),
    );
    const invalid = prepareWorkflowGenesis(control, 'session_wf_governed', governedProfile, 'setup.json');
    expect(() => invalid.build(now)).toThrow(/declared by the adopted plan/);
  });
  it('enrolls product reviews on their declared caller and requires a base-branch caller for instructions', async () => {
    const { control } = await governedWorkflowFixture();
    await writeFile(path.join(control, 'plan.json'), JSON.stringify(proofPlan()));
    const prepared = prepareWorkflowGenesis(control, 'session_wf_governed', governedProfile, 'setup.json');
    const genesis = prepared.build(now);
    expect(genesis.source_policies['signed-review']).toBeDefined();
    expect(genesis.source_policies['signed-instruction']).toBeUndefined();
  });
  it('identifies a future setup version per run while identifying malformed current setups and damaged retained bytes', async () => {
    const { control, setup } = await governedWorkflowFixture();
    const run = 'session_wf_compatibility';
    const prepare = () => prepareWorkflowGenesis(control, run, governedProfile, 'setup.json');
    const genesis = prepare().build(now);
    const future = { schema_version: 'threadloop.workflow-setup/3', future_specific: 'opaque' };
    await writeFile(path.join(control, 'setup.json'), JSON.stringify(future));
    const diagnostic = {
      code: 'WORKFLOW_RUNTIME_UNSUPPORTED',
      details: {
        workflow_run_id: run,
        schema_version: future.schema_version,
        reason: 'unsupported_workflow_setup',
        supported_schema_version: 'threadloop.workflow-setup/2',
        hint: expect.stringContaining('runtime') as string,
      },
    };
    expect(prepare).toThrowError(expect.objectContaining(diagnostic));
    const retained = structuredClone(genesis);
    Object.assign(retained, { setup: future, setup_sha256: workflowDigest(future) });
    expect(() => validateWorkflowGenesis(retained)).toThrowError(expect.objectContaining(diagnostic));
    retained.setup_sha256 = genesis.setup_sha256;
    expect(() => validateWorkflowGenesis(retained)).toThrowError(expect.objectContaining({ code: 'STATE_CORRUPTED' }));
    for (const version of ['threadloop.workflow-setup/1', 'threadloop.workflow-setup/2']) {
      await writeFile(path.join(control, 'setup.json'), JSON.stringify({ schema_version: version }));
      expect(captureError(ThreadloopError, prepare)).toMatchObject({
        code: 'INVALID_ARGUMENT',
        message: 'The workflow setup must match ' + version + '.',
        details: { reason: 'invalid_workflow_setup' },
      });
    }
    for (const invalid of [
      { ...setup, policy: null },
      { ...setup, schema_version: 'threadloop.workflow-setup/02' },
    ]) {
      await writeFile(path.join(control, 'setup.json'), JSON.stringify(invalid));
      expect(prepare).toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
      Object.assign(retained, { setup: invalid, setup_sha256: workflowDigest(invalid) });
      expect(() => validateWorkflowGenesis(retained)).toThrowError(
        expect.objectContaining({ code: 'STATE_CORRUPTED' }),
      );
    }
  });

  it.each(['preparation_ttl_ms', 'evidence_ttl_ms'] as const)(
    'rejects %s when the deadline exceeds the controller timestamp range',
    async (field) => {
      const { control } = await governedWorkflowFixture();
      const filename = path.join(control, 'sources.json');
      const sources = JSON.parse(await readFile(filename, 'utf8')) as WorkflowSources;
      if (!sources.github) throw new Error('The fixture requires registered GitHub sensors.');
      const maxLifetime = Date.parse('9999-12-31T23:59:59.999Z') - Date.parse(now);
      const prepare = () => prepareWorkflowGenesis(control, 'session_wf_lifetime', governedProfile, 'setup.json');
      for (const lifetime of [Number.MAX_SAFE_INTEGER, maxLifetime + 1]) {
        sources.github[field] = lifetime;
        await writeFile(filename, JSON.stringify(sources));
        expect(captureError(ThreadloopError, () => prepare().build(now))).toMatchObject({
          code: 'INVALID_ARGUMENT',
          details: { reason: 'invalid_workflow_deadline', field },
        });
      }
      sources.github[field] = maxLifetime;
      await writeFile(filename, JSON.stringify(sources));
      expect(prepare().build(now).sources?.github?.[field]).toBe(maxLifetime);
    },
  );
});
