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
export const TASK_STATUS = Object.freeze({
  QUEUED: 'queued',
  FRAMED: 'framed',
  PROOF_READY: 'proof_ready',
  IMPLEMENTING: 'implementing',
  VERIFYING: 'verifying',
  REVIEWING: 'reviewing',
  REPAIRING: 'repairing',
  READY_FOR_HUMAN: 'ready_for_human',
  BLOCKED: 'blocked',
  COMPLETED: 'completed',
} as const);
export type TaskStatus = (typeof TASK_STATUS)[keyof typeof TASK_STATUS];
export const TASK_STATUS_VALUES = Object.freeze(Object.values(TASK_STATUS));
const TASK_STATUS_SET = new Set<string>(TASK_STATUS_VALUES);

export function isTaskStatus(value: string): value is TaskStatus {
  return TASK_STATUS_SET.has(value);
}
export const HEARTBEAT_SOURCES = ['cli', 'daemon', 'reconcile'] as const;
export const ENTRY_SOURCES = ['cli', 'agent'] as const;
export const DEFAULT_BASE_REF = 'main' as const;

export type EntryKind = (typeof ENTRY_KINDS)[number];
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export type HeartbeatSource = (typeof HEARTBEAT_SOURCES)[number];
export type EntrySource = (typeof ENTRY_SOURCES)[number];

export interface Task {
  id: string;
  title: string;
  goal: string;
  constraints: string[];
  issueRef: string | null;
  repoRoot: string;
  status: TaskStatus;
  stateVersion: number;
  blockedFromState: TaskStatus | null;
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
  source: EntrySource;
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
  snapshotSource?: 'stored' | 'live';
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

export interface StoredRepoSnapshot {
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
  reconciledAt: string;
}
