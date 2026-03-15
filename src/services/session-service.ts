import path from 'node:path';
import { ensureThreadloopStateIgnored } from '../adapters/fs/gitignore.js';
import { createId, ensureThreadloopLayout, readConfig, readState, withArtifact, withEntry, withSession, withTask, writeArtifactFile, writeConfig, writeState } from '../adapters/fs/json-store.js';
import { isThreadloopInitialized } from '../adapters/fs/repo.js';
import { refExists, resolveRepoRoot, snapshotRepo } from '../adapters/git/client.js';
import type { ArtifactKind, EntryKind, Session, StateData, Task } from '../domain/types.js';
import { renderArtifact } from '../renderers/markdown/artifacts.js';

export interface StartTaskInput {
  cwd: string;
  title: string;
  goal: string;
  constraints: string[];
  baseRef: string | null;
}

export interface CaptureInput {
  cwd: string;
  kind: EntryKind;
  body: string;
  because?: string;
}

export async function initThreadloop(cwd: string) {
  const repoRoot = await resolveRepoRoot(cwd);
  await ensureThreadloopLayout(repoRoot);

  const created = !isThreadloopInitialized(repoRoot);
  if (created) {
    await writeConfig(repoRoot, { version: 1, createdAt: new Date().toISOString() });
    await writeState(repoRoot, { tasks: [], sessions: [], entries: [], artifacts: [], active: null });
  } else {
    await readConfig(repoRoot);
  }

  const gitignoreStatus = await ensureThreadloopStateIgnored(repoRoot);
  return { repoRoot, created, gitignoreStatus };
}

export async function startTask(input: StartTaskInput) {
  const repoRoot = await resolveRepoRoot(input.cwd);
  await assertInitialized(repoRoot);
  const state = await readState(repoRoot);

  if (state.active) {
    throw new Error('A session is already active in this repo. Finish it before starting another.');
  }

  if (input.baseRef && !(await refExists(repoRoot, input.baseRef))) {
    throw new Error(`Base ref not found: ${input.baseRef}`);
  }

  const snapshot = await snapshotRepo(repoRoot, 'preview', input.baseRef);
  const task: Task = {
    id: createId('task'),
    title: input.title,
    goal: input.goal,
    constraints: input.constraints,
    repoRoot,
    status: 'active',
    createdAt: new Date().toISOString(),
  };

  const session: Session = {
    id: createId('session'),
    taskId: task.id,
    startedAt: new Date().toISOString(),
    endedAt: null,
    baseRef: input.baseRef,
    branch: snapshot.branch,
    headSha: snapshot.headSha,
  };

  let nextState = withTask(state, task);
  nextState = withSession(nextState, session);

  nextState = withEntry(nextState, {
    id: createId('entry'),
    sessionId: session.id,
    kind: 'intent',
    body: `Task started: ${task.title}`,
    metadata: { goal: task.goal, constraints: task.constraints },
    createdAt: new Date().toISOString(),
    source: 'cli',
  });

  await writeState(repoRoot, nextState);
  return { repoRoot, task, session };
}

export async function captureEntry(input: CaptureInput) {
  const repoRoot = await resolveRepoRoot(input.cwd);
  await assertInitialized(repoRoot);
  const state = await readState(repoRoot);
  const active = requireActiveState(state);

  const entry = {
    id: createId('entry'),
    sessionId: active.sessionId,
    kind: input.kind,
    body: input.body,
    metadata: input.because ? { because: input.because } : {},
    createdAt: new Date().toISOString(),
    source: 'cli' as const,
  };

  const nextState = withEntry(state, entry);
  await writeState(repoRoot, nextState);
  return { repoRoot, entry };
}

export async function getStatus(cwd: string) {
  const repoRoot = await resolveRepoRoot(cwd);
  await assertInitialized(repoRoot);
  const state = await readState(repoRoot);
  const active = state.active;

  if (!active) {
    return { repoRoot, active: null, entries: [], repoSnapshot: null };
  }

  const task = state.tasks.find((item) => item.id === active.taskId);
  const session = state.sessions.find((item) => item.id === active.sessionId);

  if (!task || !session) {
    throw new Error('Active session state is corrupted.');
  }

  const entries = state.entries.filter((entry) => entry.sessionId === session.id);
  const repoSnapshot = await snapshotRepo(repoRoot, session.id, session.baseRef);
  return { repoRoot, active: { task, session }, entries, repoSnapshot };
}

export async function generateArtifact(cwd: string, artifactKind: ArtifactKind) {
  const repoRoot = await resolveRepoRoot(cwd);
  await assertInitialized(repoRoot);
  const state = await readState(repoRoot);
  const active = requireActiveState(state);

  const task = mustFind(state.tasks, active.taskId, 'task');
  const session = mustFind(state.sessions, active.sessionId, 'session');
  const entries = state.entries.filter((entry) => entry.sessionId === session.id);
  const repoSnapshot = await snapshotRepo(repoRoot, session.id, session.baseRef);
  const generatedAt = new Date().toISOString();
  const filename = `${slugify(task.title)}.${artifactKind}.md`;
  const content = renderArtifact({
    task,
    session,
    entries,
    repoSnapshot,
    generatedAt,
    artifactKind,
  });

  const fullPath = await writeArtifactFile(repoRoot, filename, content);
  const artifact = {
    id: createId('artifact'),
    sessionId: session.id,
    kind: artifactKind,
    path: path.relative(repoRoot, fullPath),
    templateVersion: 'v1',
    generatedAt,
  };

  await writeState(repoRoot, withArtifact(state, artifact));
  return { repoRoot, artifact, fullPath };
}

export async function finishSession(cwd: string) {
  const repoRoot = await resolveRepoRoot(cwd);
  await assertInitialized(repoRoot);
  const state = await readState(repoRoot);
  const active = requireActiveState(state);

  const nextState: StateData = {
    ...state,
    tasks: state.tasks.map((task) => (task.id === active.taskId ? { ...task, status: 'completed' } : task)),
    sessions: state.sessions.map((session) =>
      session.id === active.sessionId ? { ...session, endedAt: new Date().toISOString() } : session,
    ),
    active: null,
  };

  await writeState(repoRoot, nextState);
  return { repoRoot, taskId: active.taskId, sessionId: active.sessionId };
}

async function assertInitialized(repoRoot: string) {
  if (!isThreadloopInitialized(repoRoot)) {
    throw new Error('ThreadLoop is not initialized in this repo. Run `threadloop init` first.');
  }
  await readConfig(repoRoot);
}

function requireActiveState(state: StateData) {
  if (!state.active) {
    throw new Error('No active session in this repo. Start one with `threadloop start`.');
  }
  return state.active;
}

function mustFind<T extends { id: string }>(items: T[], id: string, label: string) {
  const item = items.find((value) => value.id === id);
  if (!item) {
    throw new Error(`Could not find active ${label}.`);
  }
  return item;
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'artifact';
}
