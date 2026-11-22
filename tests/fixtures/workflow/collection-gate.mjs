import { appendFileSync, existsSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';

const [counter, release] = process.argv.slice(2);
appendFileSync(counter, 'invoked\n');
process.stdout.write('local gate counted\n');
const deadline = Date.now() + 15_000;
while (release && !existsSync(release)) {
  if (Date.now() >= deadline) throw new Error("The collection test didn't release the gate.");
  await setTimeout(20);
}
