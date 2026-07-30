import matter from 'gray-matter';
import type { ArtifactKind, Entry, RepoSnapshot, Session, Task } from '../../domain/types.js';

export interface HandoffGovernance {
  lifecycle: {
    state: string;
    state_version: number;
    phase: string;
    storage_schema_version: number;
    contract_status: string;
    history: Array<{
      id: string;
      from_state: string;
      to_state: string;
      from_state_version: number;
      to_state_version: number;
      actor: string;
      created_at: string;
    }>;
  };
  pre_pr_review: {
    status: string;
    head_sha: string | null;
    evidence_ref: string | null;
    evidence_sha256: string | null;
    findings: Array<{ id: string; summary: string; path: string }>;
    iteration_count: number;
  };
  implementation_basis: {
    head_sha: string | null;
    source: string | null;
  };
  proof: {
    status: string;
    plan_sha256: string | null;
    baseline_head_sha: string | null;
  };
  ci_proof: { status: string };
  staleness: { status: string };
  review: {
    status: string;
    decision: string | null;
    blocking_findings: Array<{
      id: string;
      url: string;
      body: string;
      path: string | null;
      line: number | null;
    }>;
    approvals: Array<{
      actorLogin?: string;
      actorType: string;
      commitSha: string;
    }>;
    human_approval_current: boolean;
    merged: boolean;
    merged_at: string | null;
  };
  repair_budget: {
    status: string;
    attempts_used: number | null;
    limit: number;
    remaining: number | null;
  };
  audit: {
    status: string;
    event_count: number | null;
    root: string | null;
    coverage: string;
  };
  next_human_action: { code: string; description: string } | null;
}

export interface ArtifactRenderInput {
  task: Task;
  session: Session;
  entries: Entry[];
  repoSnapshot: RepoSnapshot;
  generatedAt: string;
  artifactKind: ArtifactKind;
  governance?: HandoffGovernance;
}

function section(title: string, lines: string[]) {
  return [`## ${title}`, '', ...lines, ''].join('\n');
}

function bullets(entries: Entry[], emptyState: string) {
  if (entries.length === 0) {
    return [emptyState];
  }

  return entries.map((entry) => {
    const because = typeof entry.metadata.because === 'string' ? ` — ${entry.metadata.because}` : '';
    return `- ${entry.body}${because}`;
  });
}

function frontmatterFor(input: ArtifactRenderInput) {
  const { task, session, repoSnapshot, generatedAt, artifactKind } = input;
  return {
    kind: artifactKind,
    ...(artifactKind === 'handoff' ? { contract_version: 3 } : {}),
    task_id: task.id,
    session_id: session.id,
    issue_ref: task.issueRef,
    generated_at: generatedAt,
    branch: repoSnapshot.branch,
    base_ref: repoSnapshot.baseRef,
    head_sha: repoSnapshot.headSha,
    changed_files: repoSnapshot.changedFiles,
    ...(artifactKind === 'handoff' ? { audit_root: input.governance?.audit.root ?? null } : {}),
  };
}

function gitAppendix(repoSnapshot: RepoSnapshot) {
  return section('Git context appendix', [
    `- Branch: ${repoSnapshot.branch || '(detached)'}`,
    `- Head SHA: ${repoSnapshot.headSha}`,
    `- Diff stats: ${repoSnapshot.diffStats.files} files, +${repoSnapshot.diffStats.insertions} / -${repoSnapshot.diffStats.deletions}`,
    `- Commits since base: ${repoSnapshot.commitRange.length > 0 ? '' : 'None'}`,
    ...repoSnapshot.commitRange.map((commit) => `  - ${commit}`),
  ]);
}

function renderChangeBrief(input: ArtifactRenderInput) {
  const { task, session, entries, repoSnapshot } = input;
  const summary = [
    task.goal ? `Task goal: ${task.goal}.` : `Task: ${task.title}.`,
    repoSnapshot.changedFiles.length > 0
      ? `Current Git scope touches ${repoSnapshot.changedFiles.length} file(s).`
      : 'No Git-tracked changes detected yet.',
  ].join(' ');

  return [
    `# ${task.title}`,
    '',
    section('Summary', [summary]),
    section('Goal and context', [
      `- Goal: ${task.goal || 'Not provided'}`,
      `- Constraints: ${task.constraints.length > 0 ? task.constraints.join('; ') : 'None recorded'}`,
      `- Started: ${session.startedAt}`,
      `- Base ref: ${session.baseRef ?? 'Not set'}`,
    ]),
    section(
      'What changed',
      repoSnapshot.changedFiles.length > 0
        ? repoSnapshot.changedFiles.map((file) => `- ${file}`)
        : ['- No changed files detected'],
    ),
    section(
      'Key decisions and why',
      bullets(
        entries.filter((entry) => entry.kind === 'decision'),
        'No decisions recorded.',
      ),
    ),
    section(
      'Risks and follow-ups',
      bullets(
        entries.filter((entry) => entry.kind === 'risk'),
        'No explicit risks recorded.',
      ),
    ),
    section(
      'Validation performed',
      bullets(
        entries.filter((entry) => entry.kind === 'validation'),
        'No validation recorded.',
      ),
    ),
    section(
      'Reviewer guidance',
      bullets(
        entries.filter((entry) => entry.kind === 'reviewer_guidance'),
        'No reviewer guidance recorded.',
      ),
    ),
    gitAppendix(repoSnapshot),
  ].join('\n');
}

function renderPrSummary(input: ArtifactRenderInput) {
  const { task, session, entries, repoSnapshot } = input;

  return [
    `# PR Summary: ${task.title}`,
    '',
    section('Summary', [task.goal || 'No goal recorded.']),
    section('PR metadata', [
      `- Branch: ${repoSnapshot.branch || session.branch || '(detached)'}`,
      `- Base ref: ${repoSnapshot.baseRef ?? session.baseRef ?? 'Not set'}`,
      `- Issue: ${task.issueRef ?? 'Not recorded'}`,
      ...(task.issueRef ? [`- Closing reference: Closes ${task.issueRef}`] : []),
    ]),
    section(
      'Changes in scope',
      repoSnapshot.changedFiles.length > 0
        ? repoSnapshot.changedFiles.map((file) => `- ${file}`)
        : ['- No changed files detected'],
    ),
    section(
      'Key decisions',
      bullets(
        entries.filter((entry) => entry.kind === 'decision'),
        'No decisions recorded.',
      ),
    ),
    section(
      'Validation',
      bullets(
        entries.filter((entry) => entry.kind === 'validation'),
        'No validation recorded.',
      ),
    ),
    section(
      'Reviewer guidance',
      bullets(
        entries.filter((entry) => entry.kind === 'reviewer_guidance'),
        'No reviewer guidance recorded.',
      ),
    ),
  ].join('\n');
}

function renderHandoff(input: ArtifactRenderInput) {
  const { task, session, entries, repoSnapshot } = input;
  const governance = input.governance;
  if (!governance) {
    throw new Error('Handoff rendering requires the governed session projection.');
  }

  return [
    `# Handoff: ${task.title}`,
    '',
    section('Current state', [
      `- Goal: ${task.goal || 'Not provided'}`,
      `- Branch: ${repoSnapshot.branch || session.branch || '(detached)'}`,
      `- Base ref: ${session.baseRef ?? 'Not set'}`,
      `- Changed files: ${repoSnapshot.changedFiles.length}`,
      `- Lifecycle: ${governance.lifecycle.state} @ ${governance.lifecycle.state_version}`,
      `- Lifecycle phase: ${governance.lifecycle.phase}`,
      `- Storage schema: v${governance.lifecycle.storage_schema_version} (${governance.lifecycle.contract_status})`,
    ]),
    section(
      'Lifecycle history',
      governance.lifecycle.history.length > 0
        ? governance.lifecycle.history.map(
            (transition) =>
              `- ${transition.from_state} -> ${transition.to_state} ` +
              `(${transition.from_state_version} -> ${transition.to_state_version}) by ${transition.actor} ` +
              `at ${transition.created_at}`,
          )
        : ['No lifecycle transitions recorded.'],
    ),
    section('Proof and freshness', [
      `- Local proof: ${governance.proof.status}`,
      `- Signed CI proof: ${governance.ci_proof.status}`,
      `- Freshness: ${governance.staleness.status}`,
      `- Proof plan SHA-256: ${governance.proof.plan_sha256 ?? 'Not available'}`,
      `- Baseline HEAD: ${governance.proof.baseline_head_sha ?? 'Not available'}`,
      `- Implementation basis: ${governance.implementation_basis.head_sha ?? 'Not available'}`,
      `- Implementation basis source: ${governance.implementation_basis.source ?? 'Not available'}`,
    ]),
    section('Pre-PR review and iteration', [
      `- Status: ${governance.pre_pr_review.status}`,
      `- Reviewed HEAD: ${governance.pre_pr_review.head_sha ?? 'Not available'}`,
      `- Evidence reference: ${governance.pre_pr_review.evidence_ref ?? 'Not available'}`,
      `- Evidence SHA-256: ${governance.pre_pr_review.evidence_sha256 ?? 'Not available'}`,
      `- Iterations authorized: ${governance.pre_pr_review.iteration_count}`,
      `- Findings: ${governance.pre_pr_review.findings.length}`,
      ...governance.pre_pr_review.findings.map(
        (finding) => `  - [${finding.id}] ${finding.path}: ${oneLine(finding.summary)}`,
      ),
    ]),
    section(
      'Review findings',
      governance.review.blocking_findings.length > 0
        ? governance.review.blocking_findings.map(
            (finding) =>
              `- [${finding.id}] ${finding.path ?? '(general)'}${finding.line ? `:${finding.line}` : ''}: ` +
              `${oneLine(finding.body)} (${finding.url})`,
          )
        : ['No unresolved current review findings.'],
    ),
    section('Repair budget', [
      `- Status: ${governance.repair_budget.status}`,
      `- Attempts used: ${governance.repair_budget.attempts_used ?? 'Unavailable'}`,
      `- Limit: ${governance.repair_budget.limit}`,
      `- Remaining: ${governance.repair_budget.remaining ?? 'Unavailable'}`,
    ]),
    section('Human approval and merge', [
      `- Review evidence: ${governance.review.status}`,
      `- Review decision: ${governance.review.decision ?? 'Not observed'}`,
      `- Current human approval: ${governance.review.human_approval_current ? 'yes' : 'no'}`,
      `- Merge observed: ${governance.review.merged ? 'yes' : 'no'}`,
      `- Merged at: ${governance.review.merged_at ?? 'Not observed'}`,
      `- Approvals: ${governance.review.approvals.length}`,
      ...governance.review.approvals.map(
        (approval) => `  - ${approval.actorLogin ?? '(unknown)'} (${approval.actorType}) @ ${approval.commitSha}`,
      ),
    ]),
    section('Audit evidence', [
      `- Status: ${governance.audit.status}`,
      `- Events: ${governance.audit.event_count ?? 'Unavailable'}`,
      `- Root SHA-256: ${governance.audit.root ?? 'Unavailable'}`,
      `- Coverage: ${governance.audit.coverage}`,
    ]),
    section('Next human action', [
      governance.next_human_action
        ? `- ${governance.next_human_action.code}: ${governance.next_human_action.description}`
        : 'No human action is currently required.',
    ]),
    section(
      'Open risks',
      bullets(
        entries.filter((entry) => entry.kind === 'risk'),
        'No explicit risks recorded.',
      ),
    ),
    section(
      'Important notes',
      bullets(
        entries.filter((entry) => entry.kind === 'note' || entry.kind === 'constraint'),
        'No additional notes recorded.',
      ),
    ),
    section(
      'Validation already done',
      bullets(
        entries.filter((entry) => entry.kind === 'validation'),
        'No validation recorded.',
      ),
    ),
    section(
      'Suggested reviewer/operator focus',
      bullets(
        entries.filter((entry) => entry.kind === 'reviewer_guidance'),
        'No reviewer guidance recorded.',
      ),
    ),
    gitAppendix(repoSnapshot),
  ].join('\n');
}

function oneLine(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

export function renderArtifact(input: ArtifactRenderInput) {
  const body =
    input.artifactKind === 'change-brief'
      ? renderChangeBrief(input)
      : input.artifactKind === 'pr-summary'
        ? renderPrSummary(input)
        : renderHandoff(input);

  return matter.stringify(body.trimEnd() + '\n', frontmatterFor(input));
}
