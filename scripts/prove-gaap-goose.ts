/** Called by the owned Python provider harness; never uses ambient signer trust. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { controllerBinding } from '../tests/fixtures/gaap-controller.js';
import { gaapFixture } from '../tests/fixtures/gaap.js';
import { GaapState } from '../src/adapters/fs/gaap-state.js';
import type { GaapHost } from '../src/domain/gaap-binding.js';
import { parseGaapJson } from '../src/domain/gaap-json.js';
import { inspectGaapExecutor, registerGaapExecutor, runGaapExecutor } from '../src/services/gaap-executor.js';
import type { GaapRequest } from 'threadloop-contracts/executor';

const [configuration, binary, attestor, output] = process.argv.slice(2);
if (!configuration || !binary || !attestor || !output)
  throw new Error('Pass CONFIG HOST ATTESTOR NEW_OUTPUT_DIRECTORY.');
const config = JSON.parse(readFileSync(configuration, 'utf8')) as { agent: { working_directory: string } };
const workspace = config.agent.working_directory;
const template = parseGaapJson(execFileSync(binary, ['--describe', configuration], { timeout: 15000 })) as GaapRequest;
const fixture = await gaapFixture();
const implementationDigest = 'sha256:' + createHash('sha256').update(readFileSync(binary)).digest('hex');
const host: GaapHost = {
  schema_version: 'threadloop.gaap-host/1',
  executable: process.execPath,
  arguments: [
    fileURLToPath(import.meta.resolve('tsx/cli')),
    fileURLToPath(new URL('../tests/fixtures/gaap-native-producer.ts', import.meta.url)),
  ],
  workspace,
  timeout_ms: 90000,
  environment: {
    GAAP_NATIVE_CONFIG: configuration,
    GAAP_NATIVE_HOST: binary,
    GAAP_NATIVE_ATTESTOR: attestor,
    GAAP_NATIVE_IMPLEMENTATION_DIGEST: implementationDigest,
  },
  verification: {
    id: 'explicit-native-public-fixture-only',
    keys: fixture.keys.map((key) => ({
      key_id: key.keyId,
      public_key_hex: Buffer.from(key.publicKey).toString('hex'),
    })),
    implementation: { name: 'gaap-governed-goose', version: '0.1.0', digest: implementationDigest },
  },
};
const binding = await controllerBinding(workspace, host, template);
binding.lease_ms = 120000;
host.environment.GAAP_NATIVE_MAPPING = JSON.stringify(binding.mapping_policy);
const store = new GaapState(path.join(output, 'state'));
const adopted = registerGaapExecutor(store, binding, host);
writeFileSync(path.join(output, 'binding.json'), JSON.stringify(binding, null, 2));
writeFileSync(path.join(output, 'host.json'), JSON.stringify(host, null, 2));
writeFileSync(path.join(output, 'executor-request.json'), JSON.stringify(adopted.request, null, 2));
const result = await runGaapExecutor(store);
writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
const inspection = await inspectGaapExecutor(new GaapState(store.directory));
writeFileSync(path.join(output, 'inspection.json'), JSON.stringify(inspection, null, 2));
if ('sha256:' + createHash('sha256').update(readFileSync(binary)).digest('hex') !== implementationDigest)
  throw new Error('The native host binary changed during the proof.');
const git = (directory: string, ...arguments_: string[]) =>
  execFileSync('git', ['-C', directory, ...arguments_], { encoding: 'utf8' }).trim();
const project = fileURLToPath(new URL('../', import.meta.url));
writeFileSync(
  path.join(output, 'provenance.json'),
  JSON.stringify(
    {
      schema_version: 'threadloop.gaap-native-proof/1',
      consumer_commit: git(project, 'rev-parse', 'HEAD'),
      consumer_tree_dirty: git(project, 'status', '--porcelain') !== '',
      gaap_commit: git(path.dirname(binary), 'rev-parse', 'HEAD'),
      gaap_tree_dirty: git(path.dirname(binary), 'status', '--porcelain') !== '',
      implementation_digest: implementationDigest,
      attestor_digest: 'sha256:' + createHash('sha256').update(readFileSync(attestor)).digest('hex'),
      request_digest: adopted.request.request_digest,
      claim: adopted.request.request.claim,
      attempt_id: adopted.request.request.attempt_id,
      provider: 'Local deterministic fixture; no inference or external billing.',
      signer: 'Deliberately public fixture seed; explicit host trust only.',
    },
    null,
    2,
  ),
);
if (
  result.status !== 'admitted' ||
  inspection.admitted.length !== 1 ||
  inspection.workflow_state !== 'implementing' ||
  inspection.state_version !== 2
)
  throw new Error('Native evidence failed admission or changed ThreadLoop lifecycle state: ' + JSON.stringify(result));
if (
  !('evaluation' in result) ||
  !result.evaluation ||
  result.evaluation.candidates.some((candidate) => candidate.available)
)
  throw new Error('The native edit bypassed ThreadLoop commit/proof guards.');
process.stdout.write(JSON.stringify({ output, result, inspection }, null, 2) + '\n');
