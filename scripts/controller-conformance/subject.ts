import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { canonicalExecutorJson, parseExecutorMessage } from 'threadloop-contracts/executor';
import requestSchema from 'threadloop-contracts/assets/controller-conformance-v0.1/schemas/request.schema.json' with { type: 'json' };
import responseSchema from 'threadloop-contracts/assets/controller-conformance-v0.1/schemas/response.schema.json' with { type: 'json' };
import { z } from 'zod';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import { measureSubject } from './artifact.js';
import { runControllerOperation, type Operation } from './operations.js';

declare const THREADLOOP_SUBJECT_VERSION: string;
declare const THREADLOOP_SUBJECT_REVISION: string;
interface Request {
  request: {
    protocol: string;
    schema: string;
    fixture_schema: string;
    canonicalization: string;
    digest_profile: string;
    corpus_digest: string;
    case_id: string;
    operation: Operation;
    input: unknown;
    input_digest: string;
  };
  request_digest: string;
}
const validator = new Ajv2020({ strict: true, strictTypes: false });
const dateTime = z.iso.datetime({ precision: 3 });
validator.addFormat('date-time', { type: 'string', validate: (value: string) => dateTime.safeParse(value).success });
const validRequest = validator.compile<Request>(requestSchema);
const validResponse = validator.compile(responseSchema);
const maxFramedBytes = 16 * 1024 * 1024 + 1;

async function readRequest() {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const bytes of process.stdin as AsyncIterable<Buffer>) {
    length += bytes.length;
    if (length > maxFramedBytes) throw new Error('Request exceeds the frozen message byte limit.');
    chunks.push(bytes);
  }
  const parsed = parseExecutorMessage(Buffer.concat(chunks, length));
  if (!parsed.ok) throw new Error('Invalid conformance request framing: ' + parsed.diagnostics[0]?.code);
  if (!validRequest(parsed.value)) throw new Error('Invalid conformance request envelope.');
  return parsed.value;
}
function canonical(value: unknown) {
  const result = canonicalExecutorJson(value);
  if (!result.ok) throw new Error('Value exceeds the frozen canonical JSON contract: ' + result.diagnostics[0]?.code);
  return result.value;
}
async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== 'conformance') throw new Error('Use the conformance command.');
  const { request, request_digest } = await readRequest();
  if (sha256(canonical(request.input)) !== request.input_digest || sha256(canonical(request)) !== request_digest)
    throw new Error('The input or request digest differs from its canonical bytes.');
  const { identity } = measureSubject(
    fileURLToPath(new URL('../../', import.meta.url)),
    THREADLOOP_SUBJECT_VERSION,
    THREADLOOP_SUBJECT_REVISION,
  );
  const result = runControllerOperation(request.operation, request.input);
  const response = {
    protocol: request.protocol,
    fixture_schema: request.fixture_schema,
    canonicalization: request.canonicalization,
    digest_profile: request.digest_profile,
    schema: 'threadloop.conformance-response/0.1',
    request_digest,
    subject: identity,
    result,
  };
  // Domain records can share bindings in memory. Each occurrence becomes a separate JSON value on the wire.
  const wireResponse: unknown = JSON.parse(JSON.stringify(response));
  const envelope = { response: wireResponse, response_digest: sha256(canonical(wireResponse)) };
  if (!validResponse(envelope)) throw new Error('The controller result failed the frozen response schema.');
  process.stdout.write(canonical(envelope) + '\n');
}
try {
  await main();
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message.slice(0, 512) : 'Conformance operation failed.') + '\n');
  process.exitCode = 1;
}
