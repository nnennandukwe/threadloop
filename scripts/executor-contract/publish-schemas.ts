import { mkdir, writeFile } from 'node:fs/promises';
import { format, resolveConfig } from 'prettier';
import { publishedExecutorSchemas } from './contracts.js';

const directory = new URL('../../docs/contracts/executor-v0.1/schemas/', import.meta.url);
await mkdir(directory, { recursive: true });
const options = await resolveConfig(directory);
for (const [name, schema] of Object.entries(publishedExecutorSchemas())) {
  await writeFile(
    new URL(`${name}.schema.json`, directory),
    await format(JSON.stringify(schema, null, 2), { ...options, parser: 'json' }),
  );
}
process.stdout.write('Updated executor-v0.1 schemas; fixture expectations and upstream snapshots were not changed.\n');
