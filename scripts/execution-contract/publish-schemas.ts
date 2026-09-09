import { mkdir, writeFile } from 'node:fs/promises';
import { publishedExecutionSchemas } from './contracts.js';
import { format, resolveConfig } from 'prettier';

const directory = new URL('../../docs/contracts/execution-v0.1/schemas/', import.meta.url);
await mkdir(directory, { recursive: true });
const options = await resolveConfig(directory.pathname);
for (const [name, schema] of Object.entries(publishedExecutionSchemas())) {
  await writeFile(
    new URL(`${name}.schema.json`, directory),
    await format(JSON.stringify(schema, null, 2), { ...options, parser: 'json' }),
  );
}
process.stdout.write('Updated docs/contracts/execution-v0.1/schemas/; fixture expectations were not changed.\n');
