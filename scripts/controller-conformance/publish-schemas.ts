import { mkdir, writeFile } from 'node:fs/promises';
import { format, resolveConfig } from 'prettier';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { publishedConformanceSchemas } from './contracts.js';

const schemas = publishedConformanceSchemas();
const validator = new Ajv2020({ strict: true, strictTypes: false, formats: { 'date-time': true } });
// Finish generation and validate every document before replacing published artifacts.
const formatOptions = await resolveConfig(new URL('../../prettier.config.mjs', import.meta.url));
const documents = await Promise.all(
  Object.entries(schemas).map(async ([name, schema]) => {
    validator.compile(schema);
    return { name, bytes: await format(JSON.stringify(schema, null, 2), { ...formatOptions, parser: 'json' }) };
  }),
);
const directory = new URL('../../docs/contracts/controller-conformance-v0.1/schemas/', import.meta.url);
await mkdir(directory, { recursive: true });
for (const document of documents) await writeFile(new URL(`${document.name}.schema.json`, directory), document.bytes);
process.stdout.write(
  `Published ${documents.length} conformance schemas; fixtures and expectations were not regenerated.\n`,
);
