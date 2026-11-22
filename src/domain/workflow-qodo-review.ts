import { z } from 'zod';
import { ThreadloopError } from '../contracts/errors.js';
import { parseGaapJson } from './gaap-json.js';

const names = z.array(z.string().min(1));
const fullReview = z.object({
  findings: z.array(
    z.object({
      id: z.string().min(1),
      title: z.string().min(1),
      action_level: z.enum(['informational', 'remediation_recommended', 'action_required']),
      location: z.object({ file_path: z.string().min(1) }),
    }),
  ),
  finding_state: z.object({
    complete: z.literal(true),
    introduced: names,
    still_open: names,
    resolved: names,
    dismissed: names,
  }),
  meta: z.object({
    analysis: z.object({ mode: z.literal('full') }),
    coverage: z.object({ complete: z.literal(true) }),
    skipped_files: z.array(z.unknown()).length(0),
    run: z.object({
      id: z.string().min(1),
      snapshot: z.object({ base_sha: z.string(), commit_sha: z.string(), tree_sha: z.string() }),
      timing: z.object({ finished_at: z.iso.datetime({ offset: true }) }),
      passes: z.array(
        z.object({
          kind: z.string(),
          agent_statuses_reported: z.boolean(),
          agents: z.array(z.object({ name: z.string(), status: z.string(), reason: z.string().optional() })),
        }),
      ),
    }),
  }),
});
const unfinished = z.union([
  z.object({ status: z.literal('working') }),
  z.object({
    meta: z.object({
      coverage: z.object({ complete: z.literal(false) }),
      run: z.object({ timing: z.object({ finished_at: z.null().optional() }).optional() }),
    }),
  }),
]);

export function pendingQodoReview(): never {
  throw new ThreadloopError('TRANSITION_GUARD_FAILED', "The Qodo review hasn't finished.", {
    details: {
      reason: 'review_pending',
      hint: 'Repeat the same collection request after the original operation finishes.',
    },
  });
}

function reject(message: string): never {
  throw new ThreadloopError('TRANSITION_GUARD_FAILED', message, {
    details: {
      reason: 'invalid_terminal_review',
      hint: 'Collect a complete current-head review with its own operation and request key.',
    },
  });
}
export function verifiedQodoReview(stdout: Uint8Array, base: string, head: string, tree: string) {
  const status = parseGaapJson(stdout);
  if (unfinished.safeParse(status).success) pendingQodoReview();
  const parsed = fullReview.safeParse(status);
  if (!parsed.success) reject('The retained review lacks complete full-diff coverage or a complete finding inventory.');
  const { meta, finding_state: state, findings: inventory } = parsed.data,
    identity = meta.run.snapshot;
  if (identity.base_sha !== base || identity.commit_sha !== head || identity.tree_sha !== tree)
    reject('The review belongs to another base, commit or tree.');
  const primary = meta.run.passes.filter((p) => p.kind === 'primary');
  if (
    primary.length !== 1 ||
    !primary[0]!.agent_statuses_reported ||
    !primary[0]!.agents.length ||
    !primary[0]!.agents.some((agent) => agent.status === 'completed') ||
    primary[0]!.agents.some(
      (agent) =>
        agent.status !== 'completed' &&
        !(
          agent.status === 'skipped' &&
          ((agent.name === 'spec-agent' && agent.reason === 'no_spec_content') ||
            (agent.name === 'conversion_agent' && agent.reason === 'no_eligible_findings'))
        ),
    )
  )
    reject('The primary review has incomplete required checks.');
  const ids = [...state.introduced, ...state.still_open];
  const dispositions = [...ids, ...state.dismissed, ...state.resolved];
  if (
    new Set(dispositions).size !== dispositions.length ||
    new Set(inventory.map((f) => f.id)).size !== inventory.length ||
    inventory.some((f) => !dispositions.includes(f.id))
  )
    reject('The review has conflicting or unclassified findings.');
  const active = ids.map(
    (id) => inventory.find((f) => f.id === id) ?? reject('The active finding inventory is incomplete.'),
  );
  const findings = active.map((f) => ({ id: f.id, blocking: f.action_level !== 'informational' }));
  const outcome: 'changes_required' | 'clean' = findings.some((f) => f.blocking) ? 'changes_required' : 'clean';
  const measured = new Date(meta.run.timing.finished_at).toISOString();
  return {
    run_id: meta.run.id,
    observed_at: measured,
    outcome,
    findings,
    details: active.map((f) => ({ id: f.id, summary: f.title, path: f.location.file_path })),
  };
}
