import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseJson, runCli } from '../helpers/cli.js';
import { cleanupTemporaryState, makeCommittedRepo, makeRepo } from '../helpers/session.js';

const quoteProfile = new URL('../fixtures/workflow/quote.yaml', import.meta.url);
const quoteDigest = '22fb31abcf828c86c0c299eed82bc0d196285a62a9875bfd96fa3d5580202234';

describe('durable Workflow Run commands', () => {
  afterEach(cleanupTemporaryState);

  it('reopens the original graph and initial state after a profile edit', async () => {
    const control = await makeRepo();
    const subject = await makeCommittedRepo({ branch: 'quote', remote: null });
    await runCli(control, ['init']);
    const profileFile = path.join(control, 'quote.yaml');
    await writeFile(profileFile, await readFile(quoteProfile));
    await writeFile(
      path.join(control, 'setup.json'),
      JSON.stringify({
        schema_version: 'threadloop.workflow-setup/1',
        subject_workspace: subject,
        repository_id: 'fixture-repository',
        policy: {
          id: 'fixture-policy',
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
    const args = ['workflow', 'create', 'shipping-quote', '--profile', 'quote.yaml', '--setup', 'setup.json', '--json'];
    const created = parseJson<{ data: unknown }>((await runCli(control, args)).stdout);
    expect(created.data).toMatchObject({
      contract_version: 1,
      workflow_run_id: 'shipping-quote',
      graph_digest: quoteDigest,
      state: 'intake',
      state_version: 0,
      evidence_revision: 0,
    });
    await writeFile(profileFile, 'schema_version: invalid\n');
    const reopened = parseJson<{ data: unknown }>(
      (await runCli(control, ['workflow', 'inspect', 'shipping-quote', '--json'])).stdout,
    );
    expect(reopened.data).toEqual(created.data);
  });
});
