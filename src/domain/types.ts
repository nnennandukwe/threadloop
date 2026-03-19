export const ENTRY_KINDS = [
  'intent',
  'note',
  'decision',
  'risk',
  'constraint',
  'validation',
  'reviewer_guidance',
] as const;

export const ARTIFACT_KINDS = ['change-brief', 'pr-summary', 'handoff'] as const;
export const TASK_STATUS = ['active', 'completed'] as const;
export const HEARTBEAT_SOURCES = ['cli', 'daemon', 'reconcile'] as const;

export type EntryKind = (typeof ENTRY_KINDS)[number];
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export type TaskStatus = (typeof TASK_STATUS)[number];
export type HeartbeatSource = (typeof HEARTBEAT_SOURCES)[number];

export interface Task {
  id: string;
  title: string;
  goal: string;
  constraints: string[];
  repoRoot: string;
  status: TaskStatus;
  createdAt: string;
}

export interface Session {
  id: string;
  taskId: string;
  startedAt: string;
  endedAt: string | null;
  baseRef: string | null;
  branch: string;
  headSha: string;
  lastHeartbeatAt: string | null;
  lastHeartbeatSource: HeartbeatSource | null;
}

export interface Entry {
  id: string;
  sessionId: string;
  kind: EntryKind;
  body: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  source: 'cli';
}

export interface RepoSnapshot {
  sessionId: string;
  branch: string;
  headSha: string;
  baseRef: string | null;
  changedFiles: string[];
  diffStats: {
    files: number;
    insertions: number;
    deletions: number;
  };
  commitRange: string[];
}

export interface Artifact {
  id: string;
  sessionId: string;
  kind: ArtifactKind;
  path: string;
  templateVersion: string;
  generatedAt: string;
}

export interface ThreadloopConfig {
  version: 1;
  createdAt: string;
}

export interface ActiveState {
  taskId: string;
  sessionId: string;
}

export interface StateData {
  tasks: Task[];
  sessions: Session[];
  entries: Entry[];
  artifacts: Artifact[];
  active: ActiveState | null;
  activeSessions: ActiveState[];
}

export interface SessionRecord {
  task: Task;
  session: Session;
}
