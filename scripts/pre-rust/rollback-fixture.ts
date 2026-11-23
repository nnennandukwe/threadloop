import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { managedWorkflowFixture } from '../../tests/helpers/workflow-execution.js';
import { governedProfile } from '../../tests/helpers/workflow-run.js';

const [mode, counterDirectory] = process.argv.slice(2);
if ((mode !== 'success' && mode !== 'effect_response_lost') || !counterDirectory) {
  throw new Error('Supply a rollback case and an invocation counter directory.');
}

const { control, subject, setup, host } = await managedWorkflowFixture(mode);
host.environment.TEST_GAAP_COUNTER_DIRECTORY = counterDirectory;
const { gaap, ...legacy } = setup;
if (gaap.host !== 'host.json') throw new Error('The rollback fixture enrolled a different host.');
await writeFile(path.join(control, gaap.host), JSON.stringify(host));
await writeFile(
  path.join(control, 'legacy.json'),
  JSON.stringify({ ...legacy, schema_version: 'threadloop.workflow-setup/1' }),
);
process.stdout.write(JSON.stringify({ control, subject, profile: governedProfile }));
