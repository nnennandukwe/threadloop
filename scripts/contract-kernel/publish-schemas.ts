import { mkdir, writeFile } from 'node:fs/promises';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { format, resolveConfig } from 'prettier';
import { publishedWorkflowGraphSchemas } from '../workflow-graph/contracts.js';
import { publishedControllerSchemas } from '../controller-contract/contracts.js';
import { publishedExecutionSchemas } from '../execution-contract/contracts.js';
import { publishedExecutorSchemas } from '../executor-contract/contracts.js';
import { publishedConformanceSchemas } from '../controller-conformance/contracts.js';

const families: Record<string, () => Record<string, object>> = {
  'workflow-graph': publishedWorkflowGraphSchemas,
  controller: publishedControllerSchemas,
  execution: publishedExecutionSchemas,
  executor: publishedExecutorSchemas,
  'controller-conformance': publishedConformanceSchemas,
};
const requested = process.argv.slice(2);
const unknown = requested.filter((name) => !Object.hasOwn(families, name));
if (requested.length === 0 || unknown.length > 0)
  throw new Error(`Name one or more contract families: ${Object.keys(families).join(', ')}.`);

// Generate and compile every requested document before replacing any published artifact.
const validator = new Ajv2020({ strict: true, strictTypes: false, validateFormats: false });
const options = await resolveConfig(new URL('../../prettier.config.mjs', import.meta.url));
const documents = [];
for (const family of requested) {
  const directory = new URL(`../../docs/contracts/${family}-v0.1/schemas/`, import.meta.url);
  for (const [name, schema] of Object.entries(families[family]!())) {
    validator.compile(schema);
    const bytes = await format(JSON.stringify(schema, null, 2), { ...options, parser: 'json' });
    documents.push({ directory, path: new URL(`${name}.schema.json`, directory), bytes });
  }
}
for (const document of documents) {
  await mkdir(document.directory, { recursive: true });
  await writeFile(document.path, document.bytes);
}
process.stdout.write(
  `Published ${documents.length} ${requested.join(', ')} schemas; fixtures, expectations, and vectors were not changed.\n`,
);
