/** Real bounded Goose host behind the frozen process interface; public fixture signing only. */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildGaapRequest,
  canonicalExecutorJson,
  mapGaapResult,
  type ExecutorRequest,
} from 'threadloop-contracts/executor';
import { observeGaapWorkspace } from '../../src/adapters/fs/gaap-files.js';
import { canonicalGaapJson, parseGaapJson } from '../../src/domain/gaap-json.js';
import type { GaapStatement } from '../../src/domain/gaap-types.js';

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
const request = parseGaapJson(Buffer.concat(chunks)) as ExecutorRequest;
const policy: unknown = JSON.parse(process.env.GAAP_NATIVE_MAPPING!);
const expected = buildGaapRequest(request, policy);
if (!expected.ok) throw new Error(JSON.stringify(expected.diagnostics));
const output = process.env.THREADLOOP_GAAP_EVIDENCE_DIRECTORY!;
const config = JSON.parse(readFileSync(process.env.GAAP_NATIVE_CONFIG!, 'utf8')) as Record<string, unknown>;
config.agent_run_request = expected.value;
config.output = path.join(output, 'native-bundle.json');
const filename = path.join(output, 'bound-host.json');
writeFileSync(filename, JSON.stringify(config));
execFileSync(process.env.GAAP_NATIVE_HOST!, [filename], {
  timeout: 60000,
  maxBuffer: 65536,
  stdio: ['ignore', 'pipe', 'pipe'],
});
const signed = path.join(output, 'signed');
execFileSync(
  process.env.GAAP_NATIVE_ATTESTOR!,
  ['fixture-sign', String(config.output), signed, process.env.GAAP_NATIVE_IMPLEMENTATION_DIGEST!],
  { timeout: 10000, maxBuffer: 65536 },
);
copyFileSync(path.join(signed, 'envelope.json'), path.join(output, 'envelope.json'));
mkdirSync(path.join(output, 'blobs'));
for (const name of readdirSync(path.join(signed, 'blobs')))
  copyFileSync(path.join(signed, 'blobs', name), path.join(output, 'blobs', name));
const envelope = JSON.parse(readFileSync(path.join(output, 'envelope.json'), 'utf8')) as { payload: string };
const statement = parseGaapJson(Buffer.from(envelope.payload, 'base64')) as GaapStatement;
const observed = observeGaapWorkspace(process.cwd());
const result = mapGaapResult(request, policy, Buffer.from(canonicalGaapJson(statement.predicate.receipt)), {
  finished_at: new Date().toISOString(),
  resulting_subject: { ...request.request.action_request.request.binding.subject, content_digest: observed.digest },
});
if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
const encoded = canonicalExecutorJson(result.value);
if (!encoded.ok) throw new Error('Native evidence produced an invalid process result.');
process.stdout.write(encoded.value + '\n');
