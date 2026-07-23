import matter from 'gray-matter';
import type { ArtifactKind, Entry, RepoSnapshot, Session, Task } from '../../domain/types.js';

export interface ArtifactRenderInput {
  task: Task;
  session: Session;
  entries: Entry[];
  repoSnapshot: RepoSnapshot;
  generatedAt: string;
  artifactKind: ArtifactKind;
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
    task_id: task.id,
    session_id: session.id,
    issue_ref: task.issueRef,
    generated_at: generatedAt,
    branch: repoSnapshot.branch,
    base_ref: repoSnapshot.baseRef,
    head_sha: repoSnapshot.headSha,
    changed_files: repoSnapshot.changedFiles,
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

  return [
    `# Handoff: ${task.title}`,
    '',
    section('Current state', [
      `- Goal: ${task.goal || 'Not provided'}`,
      `- Branch: ${repoSnapshot.branch || session.branch || '(detached)'}`,
      `- Base ref: ${session.baseRef ?? 'Not set'}`,
      `- Changed files: ${repoSnapshot.changedFiles.length}`,
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

export function renderArtifact(input: ArtifactRenderInput) {
  const body =
    input.artifactKind === 'change-brief'
      ? renderChangeBrief(input)
      : input.artifactKind === 'pr-summary'
        ? renderPrSummary(input)
        : renderHandoff(input);

  return matter.stringify(body.trimEnd() + '\n', frontmatterFor(input));
}
