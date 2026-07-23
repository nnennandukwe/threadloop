import type { EntrySource } from '../domain/types.js';
import prompts from 'prompts';
import { readTextFromEditor } from '../adapters/fs/editor.js';
import { writeCommandSuccess, type CommandContext } from './runtime.js';
import { startTask } from '../services/session-service.js';

export interface StartOptions {
  goal?: string;
  constraint?: string[];
  base?: string;
  issue?: string;
  actor?: EntrySource;
  goalEdit?: boolean;
}

export async function sessionStartCommand(
  context: CommandContext,
  title: string,
  options: StartOptions,
  allowMultipleActive = true,
) {
  let goal = options.goal?.trim();
  if (options.goalEdit) {
    goal = await readTextFromEditor(goal ?? '');
  }

  if (!goal) {
    const response = await prompts({
      type: 'text',
      name: 'goal',
      message: 'What is the goal of this task?',
      validate: (value: string) => (value.trim() ? true : 'Goal is required'),
    });
    if (typeof response.goal !== 'string' || !response.goal.trim()) {
      throw new Error('Goal is required.');
    }
    goal = response.goal.trim();
  }

  const result = await startTask({
    cwd: context.cwd,
    title,
    goal,
    constraints: options.constraint ?? [],
    allowMultipleActive,
    ...(options.base ? { baseRef: options.base } : {}),
    ...(options.issue ? { issueRef: options.issue } : {}),
    ...(options.actor ? { actor: options.actor } : {}),
  });

  writeCommandSuccess(context, {
    text: [
      `Started task: ${result.task.title}`,
      `Goal: ${result.task.goal}`,
      `Constraints: ${result.task.constraints.length > 0 ? result.task.constraints.join('; ') : 'none'}`,
      `Issue: ${result.task.issueRef ?? 'none'}`,
      `Session: ${result.session.id}`,
    ],
    data: {
      session_id: result.session.id,
      task_id: result.task.id,
      task: result.task,
      session: result.session,
    },
  });
}
