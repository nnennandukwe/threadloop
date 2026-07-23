import { initThreadloop } from '../services/session-service.js';

export async function initCommand() {
  const result = await initThreadloop(process.cwd());
  const initMessage = result.created
    ? `Initialized ThreadLoop in ${result.repoRoot}`
    : `ThreadLoop already initialized in ${result.repoRoot}`;
  const gitignoreMessage =
    result.gitignoreStatus === 'created'
      ? 'Created .git/info/exclude and added ThreadLoop state and receipt exclusions'
      : result.gitignoreStatus === 'updated'
        ? 'Updated .git/info/exclude to ignore ThreadLoop state and local receipts'
        : '.git/info/exclude already ignores ThreadLoop state and local receipts';

  console.log(initMessage);
  console.log(gitignoreMessage);
}
