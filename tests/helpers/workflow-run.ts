import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { makeCommittedRepo, makeTempDir, proofPlan } from './session.js';
import { fixtureRepository, trustPolicy } from '../fixtures/receipts.js';
export const governedProfile = createRequire(import.meta.url).resolve(
  'threadloop-contracts/assets/workflow-graph-v0.1/fixtures/valid/governed-pr.yaml',
);

export async function governedWorkflowFixture() {
  const control = await makeTempDir();
  const subject = await makeCommittedRepo();
  await writeFile(
    path.join(control, 'plan.json'),
    JSON.stringify({ ...proofPlan(), review: trustPolicy('review', 'threadloop.yml', 'main') }),
  );
  const sources = {
    schema_version: 'threadloop.workflow-sources/1',
    host_producers: ['local-gate', 'pre-pr-review'],
    github: { base_ref: 'main', human_node_id: 'github_user', preparation_ttl_ms: 60_000, evidence_ttl_ms: 600_000 },
  };
  await writeFile(path.join(control, 'sources.json'), JSON.stringify(sources));
  const setup = {
    schema_version: 'threadloop.workflow-setup/1',
    subject_workspace: subject,
    repository_id: fixtureRepository,
    policy: {
      id: 'governed',
      proof_binding_transition_id: 'bind_plan',
      local_gate_ids: ['check'],
      independent_gate_ids: ['check'],
      publication_destination: null,
    },
    proof_plan: 'plan.json',
    trusted_sources: 'sources.json',
    allowed_change_paths: ['README.md'],
  };
  await writeFile(path.join(control, 'setup.json'), JSON.stringify(setup));
  return { control, subject, setup };
}
