import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseJson, runCli, runCliError } from '../helpers/cli.js';
import { cleanupTemporaryState, commitFiles, makeRepo } from '../helpers/session.js';

const quoteProfile = new URL('../fixtures/workflow/quote.yaml', import.meta.url);
const quoteDigest = '22fb31abcf828c86c0c299eed82bc0d196285a62a9875bfd96fa3d5580202234';

describe('durable Workflow Run commands', () => {
  afterEach(cleanupTemporaryState);

  it('reopens the original graph and initial state after a profile edit', async () => {
    const control = await makeRepo();
    const subject = await makeRepo();
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
    const empty = await runCliError(control, args);
    expect(empty.error.message).toMatch(/initial commit/i);
    expect((await runCliError(control, ['workflow', 'inspect', 'shipping-quote', '--json'])).error.code).toBe(
      'WORKFLOW_RUN_NOT_FOUND',
    );
    await commitFiles(subject, 'Start the quote', { 'README.md': '# Quote\n' });
    const created = parseJson<{ data: unknown }>((await runCli(control, args)).stdout);
    expect(created.data).toMatchObject({
      contract_version: 1,
      workflow_run_id: 'shipping-quote',
      graph_digest: quoteDigest,
      state: 'intake',
      state_version: 0,
      evidence_revision: 0,
    });
    expect((await runCli(control, ['workflow', 'decide', 'shipping-quote'])).stdout.trim()).toBe(
      'transition_available\nstart_quote -> prepared',
    );
    await writeFile(profileFile, 'schema_version: invalid\n');
    const reopened = parseJson<{ data: unknown }>(
      (await runCli(control, ['workflow', 'inspect', 'shipping-quote', '--json'])).stdout,
    );
    expect(reopened.data).toEqual(created.data);
  });
});
