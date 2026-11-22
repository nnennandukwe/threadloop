import { expect, it } from 'vitest';
import { verifiedQodoReview } from '../../src/domain/workflow-qodo-review.js';

const base = 'a'.repeat(40),
  head = 'b'.repeat(40),
  tree = 'c'.repeat(40);
type FindingBuckets = Partial<Record<'introduced' | 'still_open' | 'resolved' | 'dismissed', string[]>>;

function readReview(inventory: string[], buckets: FindingBuckets) {
  const review = {
    meta: {
      analysis: { mode: 'full' },
      coverage: { complete: true },
      skipped_files: [],
      run: {
        id: 'inventory-check',
        snapshot: { base_sha: base, commit_sha: head, tree_sha: tree },
        timing: { finished_at: '2026-11-21T00:00:00.000Z' },
        passes: [{ kind: 'primary', agent_statuses_reported: true, agents: [{ name: 'review', status: 'completed' }] }],
      },
    },
    findings: inventory.map((id) => ({
      id,
      title: id,
      action_level: 'action_required',
      location: { file_path: 'example.ts' },
    })),
    finding_state: { complete: true, introduced: [], still_open: [], resolved: [], dismissed: [], ...buckets },
  };
  return verifiedQodoReview(Buffer.from(JSON.stringify(review)), base, head, tree);
}

it.each(['resolved', 'dismissed'] as const)('refuses a %s ID missing from the original finding inventory', (bucket) => {
  let refusal: unknown;
  try {
    readReview([], { [bucket]: ['missing'] });
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toMatchObject({ code: 'TRANSITION_GUARD_FAILED', details: { reason: 'invalid_terminal_review' } });
});

it('keeps active findings in review order and leaves classified historical findings out of active evidence', () => {
  const buckets = { introduced: ['new'], still_open: ['continuing'], resolved: ['fixed'], dismissed: ['triaged'] };
  const assessment = readReview(['fixed', 'continuing', 'triaged', 'new'], buckets);
  expect(assessment.outcome).toBe('changes_required');
  expect(assessment.findings).toEqual([
    { id: 'new', blocking: true },
    { id: 'continuing', blocking: true },
  ]);
  expect(readReview(['fixed', 'triaged'], { resolved: ['fixed'], dismissed: ['triaged'] })).toMatchObject({
    outcome: 'clean',
    findings: [],
    details: [],
  });
});
