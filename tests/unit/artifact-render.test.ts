import { describe, expect, it } from 'vitest';
import { renderArtifact } from '../../src/renderers/markdown/artifacts.js';

describe('artifact rendering', () => {
  it('keeps a multi-line capture inside its bullet', () => {
    const rendered = renderArtifact({
      artifactKind: 'change-brief',
      generatedAt: '2026-09-25T00:00:00.000Z',
      task: {
        id: 'task_1',
        title: 'Task',
        goal: 'Goal',
        constraints: [],
        issueRef: null,
        repoRoot: '/repo',
        status: 'queued',
        stateVersion: 0,
        blockedFromState: null,
        createdAt: '2026-09-25T00:00:00.000Z',
      },
      session: {
        id: 'session_1',
        taskId: 'task_1',
        startedAt: '2026-09-25T00:00:00.000Z',
        endedAt: null,
        baseRef: null,
        branch: 'main',
        headSha: 'a'.repeat(40),
        lastHeartbeatAt: null,
        lastHeartbeatSource: null,
      },
      repoSnapshot: {
        sessionId: 'session_1',
        branch: 'main',
        headSha: 'a'.repeat(40),
        baseRef: null,
        changedFiles: [],
        diffStats: { files: 0, insertions: 0, deletions: 0 },
        commitRange: [],
      },
      entries: [
        {
          id: 'entry_1',
          sessionId: 'session_1',
          kind: 'decision',
          body: 'Retry idempotent jobs\n\n- only on timeout',
          metadata: {},
          createdAt: '2026-09-25T00:00:00.000Z',
          source: 'cli',
        },
      ],
    });

    expect(rendered).toContain('- Retry idempotent jobs\n  \n  - only on timeout\n');
  });
});
