// This test process stands in for the enrolled host producer during interrupted admissions.
import { createWorkflowStore } from '../../../src/adapters/fs/workflow-store.js';
import { sha256 } from '../../../src/adapters/crypto/sha256.js';
import { admitWorkflowHostSource } from '../../../src/services/workflow-runtime.js';
import type { HostSource } from '../../../src/domain/workflow-run.js';

const [root, run, observedAt] = process.argv.slice(2);
if (!root || !run || !observedAt) throw new Error('Expected control path, run ID and measurement time');
const { genesis, view } = createWorkflowStore(root).read(run);
const producer = genesis.source_policies['pre-pr-review'];
if (!producer) throw new Error('The fixture needs its enrolled review producer');
const report = {
  reviewer_id: 'fixture-reviewer',
  head_sha: genesis.baseline.revision,
  observed_at: observedAt,
  outcome: 'clean' as const,
  findings: [],
};
const bytes = Buffer.from(JSON.stringify(report));
const digest = sha256(bytes);
const source: HostSource = {
  kind: 'pre-pr-review',
  producer_id: producer,
  reviewer_id: report.reviewer_id,
  observed_at: observedAt,
  producing: {
    binding: {
      workflow_run_id: run,
      graph_schema_version: view.graph_schema_version,
      graph_digest: view.graph_digest,
      source_state: genesis.compiled.graph.initial_state,
      state_version: 0,
      subject: genesis.baseline,
    },
    branch: genesis.baseline_branch,
    evidence_policy: producer,
    workflow_policy: view.policy,
  },
  review: {
    outcome: report.outcome,
    headSha: report.head_sha,
    evidenceRef: 'fixture-review.json',
    evidenceSha256: digest,
    findings: [],
  },
  artifact: { bytes, sha256: digest },
  findings: [],
};
const reply = await admitWorkflowHostSource(root, run, 0, source);
process.stdout.write(JSON.stringify(reply));
