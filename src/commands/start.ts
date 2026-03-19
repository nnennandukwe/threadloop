import prompts from 'prompts';
import { readTextFromEditor } from '../adapters/fs/editor.js';
import { startTask } from '../services/session-service.js';

interface StartOptions {
  goal?: string;
  constraint?: string[];
  base?: string;
  goalEdit?: boolean;
}

export async function startCommand(title: string, options: StartOptions) {
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
    cwd: process.cwd(),
    title,
    goal,
    constraints: options.constraint ?? [],
    baseRef: options.base ?? null,
    allowMultipleActive: false,
  });

  console.log(`Started task: ${result.task.title}`);
  console.log(`Goal: ${result.task.goal}`);
  console.log(`Constraints: ${result.task.constraints.length > 0 ? result.task.constraints.join('; ') : 'none'}`);
  console.log(`Session: ${result.session.id}`);
}
