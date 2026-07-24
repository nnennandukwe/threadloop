import { describe, expect, it } from 'vitest';
import { taskSchema } from '../../src/schemas/state.js';

const task = {
  id: 'task_1',
  title: 'Schema boundary',
  goal: 'Validate persisted lifecycle states',
  constraints: [],
  issueRef: null,
  repoRoot: '/repo',
  status: 'verifying',
  stateVersion: 4,
  blockedFromState: 'reviewing',
  createdAt: '2026-07-24T00:00:00.000Z',
};

describe('task state schema', () => {
  it('constructs and accepts current lifecycle values for status fields', () => {
    expect(taskSchema.parse(task)).toMatchObject({
      status: 'verifying',
      blockedFromState: 'reviewing',
    });
  });

  it('normalizes the legacy active state and rejects unknown lifecycle values', () => {
    expect(taskSchema.parse({ ...task, status: 'active' })).toMatchObject({
      status: 'queued',
    });
    expect(taskSchema.safeParse({ ...task, status: 'unknown' }).success).toBe(false);
    expect(taskSchema.safeParse({ ...task, blockedFromState: 'unknown' }).success).toBe(false);
  });
});
