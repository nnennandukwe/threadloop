import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { stateDataSchema, threadloopConfigSchema } from '../../schemas/state.js';
import type { Artifact, Entry, Session, StateData, Task, ThreadloopConfig } from '../../domain/types.js';
import { threadloopPaths } from './repo.js';

const EMPTY_STATE: StateData = {
  tasks: [],
  sessions: [],
  entries: [],
  artifacts: [],
  active: null,
};

export function createId(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

export async function ensureThreadloopLayout(repoRoot: string) {
  const paths = threadloopPaths(repoRoot);
  await mkdir(paths.root, { recursive: true });
  await mkdir(paths.stateDir, { recursive: true });
  await mkdir(paths.artifactsDir, { recursive: true });
}

export async function writeConfig(repoRoot: string, config: ThreadloopConfig) {
  const paths = threadloopPaths(repoRoot);
  await ensureThreadloopLayout(repoRoot);
  await writeJson(paths.configPath, config);
}

export async function readConfig(repoRoot: string): Promise<ThreadloopConfig> {
  const paths = threadloopPaths(repoRoot);
  const parsed = threadloopConfigSchema.safeParse(await readJson(paths.configPath));
  if (!parsed.success) {
    throw new Error('Invalid .threadloop/config.json');
  }
  return parsed.data;
}

export async function readState(repoRoot: string): Promise<StateData> {
  const paths = threadloopPaths(repoRoot);
  if (!existsSync(paths.statePath)) {
    return structuredClone(EMPTY_STATE);
  }

  const parsed = stateDataSchema.safeParse(await readJson(paths.statePath));
  if (!parsed.success) {
    throw new Error('Invalid .threadloop/state/state.json');
  }

  return parsed.data;
}

export async function writeState(repoRoot: string, state: StateData) {
  const paths = threadloopPaths(repoRoot);
  await ensureThreadloopLayout(repoRoot);
  await writeJson(paths.statePath, state);
}

export async function writeArtifactFile(repoRoot: string, filename: string, content: string) {
  const paths = threadloopPaths(repoRoot);
  await mkdir(paths.artifactsDir, { recursive: true });
  const fullPath = path.join(paths.artifactsDir, filename);
  await writeFile(fullPath, content, 'utf8');
  return fullPath;
}

export function withTask(state: StateData, task: Task): StateData {
  return { ...state, tasks: [...state.tasks, task] };
}

export function withSession(state: StateData, session: Session): StateData {
  return { ...state, sessions: [...state.sessions, session], active: { taskId: session.taskId, sessionId: session.id } };
}

export function withEntry(state: StateData, entry: Entry): StateData {
  return { ...state, entries: [...state.entries, entry] };
}

export function withArtifact(state: StateData, artifact: Artifact): StateData {
  return { ...state, artifacts: [...state.artifacts, artifact] };
}

async function readJson(filePath: string) {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function writeJson(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
