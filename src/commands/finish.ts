import { finishSession } from '../services/session-service.js';

export async function finishCommand() {
  const result = await finishSession(process.cwd());
  console.log(`Finished session ${result.sessionId}`);
}
