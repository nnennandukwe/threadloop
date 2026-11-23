// RunInvariant stays in the parent. Each child gets its own restricted launcher.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const settings = JSON.parse(fs.readFileSync(0, 'utf8'));
  const { harness, contracts, command, control, identity, canaries, controlRoot } = settings;
  const { canonical, digest, sha256 } = require(path.join(harness, 'src/threadloop/codec'));
  const { buildRequest, loadCorpus, profiles, responseSchema } = require(path.join(harness, 'src/threadloop/corpus'));
  const { runCase, validateResponse } = require(path.join(harness, 'src/threadloop/runner'));
  const { defaults, invoke } = require(path.join(harness, 'src/threadloop/process'));
  const corpus = loadCorpus(contracts);
  const inventory = corpus.fixtures.map((fixture, index) => {
    const entry = corpus.manifest.manifest.entries[index];
    const envelope = buildRequest(corpus, fixture);
    return {
      id: entry.id,
      operation: entry.operation,
      fixture_digest: entry.fixture_digest,
      input_digest: entry.input_digest,
      request_digest: envelope.request_digest,
      graph_digest:
        fixture.input.binding?.graph_digest ?? fixture.input.projection_snapshot?.binding?.graph_digest ?? null,
    };
  });
  if (settings.inventoryOnly) return inventory;
  const byId = (id) => {
    const fixture = corpus.fixtures.find((item) => item.id === id);
    assert.ok(fixture, id);
    return fixture;
  };
  const baseline = buildRequest(corpus, byId('case_024'));
  const call = async (envelope) => {
    const { stdout } = await invoke(command, Buffer.from(canonical(envelope)), defaults);
    const reply = validateResponse(corpus, envelope, stdout, identity);
    return { reply, stdout_sha256: sha256(stdout) };
  };
  const original = await call(baseline);
  const decision = original.reply.response.result.decision.decision;
  assert.equal(decision.outcome, 'blocked');
  assert.deepEqual(
    decision.reasons.map((reason) => reason.code),
    ['AMBIGUOUS_REMEDY'],
  );
  const relabeled = structuredClone(baseline);
  relabeled.request.case_id = 'case_999';
  relabeled.request_digest = digest(relabeled.request);
  corpus.validate('request', relabeled);
  assert.notEqual(relabeled.request_digest, baseline.request_digest);
  const second = await call(relabeled);
  assert.deepEqual(second.reply.response.result, original.reply.response.result);

  const fixture = byId('case_001');
  const request = buildRequest(corpus, fixture);
  const compiled = await call(request);
  assert.equal(compiled.reply.response.result.status, 'compiled');
  const invalid = { status: 'invalid', diagnostics: [{ code: 'CONTROL', identifier: null, path: '$' }] };
  async function substituted(correlation) {
    const response = {
      ...profiles,
      schema: responseSchema,
      request_digest: correlation,
      subject: identity,
      result: invalid,
    };
    const wire = canonical({ response, response_digest: digest(response) });
    return runCase(corpus, fixture, [...control, 'reply', wire], identity, defaults);
  }
  const mismatch = await substituted(request.request_digest);
  assert.equal(mismatch.status, 'nonconforming');
  const unrelated = await substituted(digest('independent correlation'));
  assert.equal(unrelated.status, 'protocol_error');
  assert.match(unrelated.diagnostic, /Request correlation/);

  Object.values(canaries).forEach((file) => assert.ok(fs.statSync(file).isFile()));
  const reads = await invoke([...control, 'read', ...Object.values(canaries)], Buffer.alloc(0), defaults);
  const denied = JSON.parse(reads.stdout);
  assert.equal(denied.length, Object.keys(canaries).length);
  assert.ok(denied.every((code) => code === 'EPERM' || code === 'EACCES'));
  assert.deepEqual(fs.readdirSync(controlRoot), []);
  const timeoutMs = 1500;
  const expired = await runCase(corpus, fixture, [...control, 'timeout'], identity, {
    ...defaults,
    timeout_ms: timeoutMs,
  });
  assert.equal(expired.status, 'transport_error');
  assert.match(expired.diagnostic, /^TIMEOUT:/);
  const leftovers = fs.readdirSync(controlRoot);
  assert.equal(leftovers.length, 1);
  assert.equal(fs.readFileSync(path.join(controlRoot, leftovers[0], 'started'), 'utf8'), 'timeout control');
  return {
    inventory,
    controls: {
      case_001: {
        request_digest: request.request_digest,
        response_digest: compiled.reply.response_digest,
        stdout_sha256: compiled.stdout_sha256,
        graph_digest: compiled.reply.response.result.compiled_graph.graph_digest,
      },
      case_024: {
        request_digest: baseline.request_digest,
        response_digest: original.reply.response_digest,
        stdout_sha256: original.stdout_sha256,
        outcome: decision.outcome,
        reason: decision.reasons[0].code,
      },
      relabeled: {
        case_id: relabeled.request.case_id,
        request_digest: relabeled.request_digest,
        response_digest: second.reply.response_digest,
        same_domain_result: true,
      },
      wrong_result: mismatch.status,
      wrong_correlation: unrelated.status,
      file_denials: Object.fromEntries(Object.keys(canaries).map((name, index) => [name, denied[index]])),
      timeout: { status: expired.status, timeout_ms: timeoutMs, started_case_directories: leftovers.length },
    },
  };
}
main()
  .then((output) => process.stdout.write(JSON.stringify(output)))
  .catch((error) => {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  });
