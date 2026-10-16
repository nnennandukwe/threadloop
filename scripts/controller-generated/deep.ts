import { checkHistories, profiles } from '../../tests/generated/controller/history.js';
import { checkProcessHistories } from '../../tests/generated/controller/process-history.js';

try {
  for (const seed of profiles.deep.seeds) {
    process.stderr.write(`Controller deep profile: seed ${seed}, ${profiles.deep.runs} histories.\n`);
    await checkHistories(seed, profiles.deep.maxSteps, profiles.deep.runs);
  }
  for (const seed of [112, 111]) {
    process.stderr.write(`Process deep profile: seed ${seed}, 24 histories.\n`);
    await checkProcessHistories(seed, true);
  }
  process.stdout.write('Deep profile passed: 512 controller histories and 48 process histories.\n');
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1;
}
