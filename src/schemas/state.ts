import { z } from 'zod';
import { ARTIFACT_KINDS, ENTRY_KINDS, ENTRY_SOURCES, HEARTBEAT_SOURCES, TASK_STATUS } from '../domain/types.js';

const persistedTaskStatusSchema = z
  .union([z.enum(TASK_STATUS), z.literal('active')])
  .transform((status) => (status === 'active' ? 'queued' : status));

export const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  goal: z.string(),
  constraints: z.array(z.string()),
  issueRef: z.string().nullable().optional().default(null),
  repoRoot: z.string(),
  status: persistedTaskStatusSchema,
  stateVersion: z.number().int().nonnegative().optional().default(0),
  blockedFromState: z.enum(TASK_STATUS).nullable().optional().default(null),
  createdAt: z.string(),
});

export const sessionSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  baseRef: z.string().nullable(),
  branch: z.string(),
  headSha: z.string(),
  lastHeartbeatAt: z.string().nullable().optional().default(null),
  lastHeartbeatSource: z.enum(HEARTBEAT_SOURCES).nullable().optional().default(null),
});

export const entrySchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  kind: z.enum(ENTRY_KINDS),
  body: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  source: z.enum(ENTRY_SOURCES),
});

export const artifactSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  kind: z.enum(ARTIFACT_KINDS),
  path: z.string(),
  templateVersion: z.string(),
  generatedAt: z.string(),
});

export const activeStateSchema = z.object({
  taskId: z.string(),
  sessionId: z.string(),
});

export const stateDataSchema = z
  .object({
    tasks: z.array(taskSchema),
    sessions: z.array(sessionSchema),
    entries: z.array(entrySchema),
    artifacts: z.array(artifactSchema),
    active: activeStateSchema.nullable(),
    activeSessions: z.array(activeStateSchema).optional(),
  })
  .transform((state) => ({
    ...state,
    tasks: state.tasks.map((task) => ({
      ...task,
      issueRef: task.issueRef ?? null,
      stateVersion: task.stateVersion ?? 0,
      blockedFromState: task.blockedFromState ?? null,
    })),
    activeSessions: state.activeSessions ?? (state.active ? [state.active] : []),
  }));

export const threadloopConfigSchema = z.object({
  version: z.literal(1),
  createdAt: z.string(),
});
