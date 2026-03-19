import prompts from 'prompts';
import { readTextFromEditor } from '../adapters/fs/editor.js';
import { writeCommandSuccess, type CommandContext } from './runtime.js';
import { startTask } from '../services/session-service.js';

interface SessionStartOptions {
  goal?: string;
  constraint?: string[];
  base?: string;
  goalEdit?: boolean;
}

export async function sessionStartCommand(context: CommandContext, title: string, options: SessionStartOptions) {
  let goal = options.goal?.trim();
  if (options.goalEdit) {
    goal = await readTextFromEditor(goal ?? '');
  }

  if (!goal) {
    const response = await prompts({
      type: 'text',
      name: 'goal',
      message: 'What is the goal of this task?',
      validate: (value) => (value.trim() ? true : 'Goal is required'),
    });
    goal = response.goal;
  }

  const result = await startTask({
    cwd: context.cwd,
    title,
    goal,
    constraints: options.constraint ?? [],
    baseRef: options.base ?? null,
  });

  writeCommandSuccess(context, {
    text: [
      `Started task: ${result.task.title}`,
      `Goal: ${result.task.goal}`,
      `Constraints: ${result.task.constraints.length > 0 ? result.task.constraints.join('; ') : 'none'}`,
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
