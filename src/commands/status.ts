import { getStatus } from '../services/session-service.js';

export async function statusCommand() {
  const result = await getStatus(process.cwd());

  if (!result.active) {
    console.log('No active session.');
    return;
  }

  const { task, session } = result.active;
  const counts = new Map<string, number>();
  for (const entry of result.entries) {
    counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
  }

  console.log(`Task: ${task.title}`);
  console.log(`Goal: ${task.goal}`);
  console.log(`Status: ${task.status}`);
  console.log(`Branch: ${result.repoSnapshot?.branch ?? session.branch}`);
  console.log(`Base ref: ${session.baseRef ?? 'not set'}`);
  console.log(`Entries: ${result.entries.length}`);
  console.log(`Changed files: ${result.repoSnapshot?.changedFiles.length ?? 0}`);
  console.log(
    `Entry kinds: ${counts.size > 0 ? Array.from(counts.entries()).map(([kind, count]) => `${kind}=${count}`).join(', ') : 'none'}`,
  );
}
