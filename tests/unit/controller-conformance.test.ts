import { describe, expect, it } from 'vitest';
import {
  canonicalConformanceJson,
  conformanceDigest,
  parseConformanceMessage,
} from '../../scripts/controller-conformance/codec.js';

describe('Controller conformance byte contract', () => {
  it('rejects noncanonical frames instead of repairing them', () => {
    for (const source of ['{"b":1,"a":2}', '{"a":1,"a":2}', '{}\r\n', '{}\n\n', '\ufeff{}', '{} {}']) {
      expect(parseConformanceMessage(Buffer.from(source)).ok).toBe(false);
    }
    expect(parseConformanceMessage(Buffer.from('{}\n'))).toEqual({ ok: true, value: {} });
  });

  it('uses UTF-16 ordering and binds exact canonical content', () => {
    expect(canonicalConformanceJson({ '2': 2, '10': 10 })).toEqual({ ok: true, value: '{"10":10,"2":2}' });
    expect(conformanceDigest({})).toBe('44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
    expect(parseConformanceMessage(new Uint8Array([0xff])).ok).toBe(false);
  });
});

import { readFile, readdir, mkdtemp, mkdir, writeFile, symlink, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import {
  loadCorpus,
  corpusDirectory,
  verifyCompatibility,
  verifyPublishedSchemas,
} from '../../scripts/controller-conformance/files.js';
import {
  buildSubjectRequest,
  compareCaseResult,
  validateCorpus,
  validateSubjectResponse,
} from '../../scripts/controller-conformance/validation.js';
import {
  compatibilitySchema,
  fixtureSchema,
  requestSchema,
  executionScenarioSchema,
  manifestSchema,
  publishedConformanceSchemas,
  versions,
  type Fixture,
  type SubjectRequest,
} from '../../scripts/controller-conformance/contracts.js';
import { validateControllerDecision } from '../../scripts/controller-contract/decision.js';
import type { ValidationResult } from '../../scripts/workflow-graph/contracts.js';
import { canonicalJson } from '../../src/domain/canonical-json.js';
import { sha256 } from '../../src/adapters/crypto/sha256.js';

function value<T>(result: ValidationResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.value;
}
const corpus = await loadCorpus();
const sources = await Promise.all(
  (await readdir(join(corpusDirectory, 'fixtures')))
    .sort()
    .map(async (name) => JSON.parse(await readFile(join(corpusDirectory, 'fixtures', name), 'utf8')) as unknown),
);
const shared = JSON.parse(await readFile(join(corpusDirectory, 'shared.json'), 'utf8')) as unknown;
const manifest = manifestSchema.parse(corpus.manifest);
const fixtures = Object.values(corpus.fixtures).map((fixture) => fixtureSchema.parse(fixture));
const subject = {
  name: 'synthetic-protocol-test',
  version: '0.1',
  revision: 'fixture-only',
  artifact_digest: '1'.repeat(64),
};
function response(fixture: Fixture, request: SubjectRequest) {
  const payload = {
    protocol: versions.protocol,
    schema: versions.response_schema,
    fixture_schema: versions.fixture_schema,
    canonicalization: versions.canonicalization,
    digest_profile: versions.digest_profile,
    request_digest: request.request_digest,
    subject,
    result: structuredClone(fixture.expected),
  };
  return { response: payload, response_digest: conformanceDigest(payload) };
}
function bytes(document: unknown) {
  return Buffer.from(value(canonicalConformanceJson(document)));
}
function listed(fixture: Fixture) {
  const updated = structuredClone(manifest);
  const entry = updated.manifest.entries.find((entry) => entry.id === fixture.id)!;
  entry.input_digest = conformanceDigest(fixture.input);
  entry.fixture_digest = conformanceDigest(fixture);
  updated.corpus_digest = conformanceDigest(updated.manifest);
  return updated;
}

describe('Published controller corpus', () => {
  it('validates all required coverage without asserting external conformance', async () => {
    const checked = value(validateCorpus(corpus.manifest, corpus.fixtures, corpus.compatibility));
    expect(checked.fixtures).toHaveLength(38);
    await verifyCompatibility(corpus.compatibility);
    const pending = fixtures.filter((fixture) => fixture.semantic_check === 'selection_pending');
    expect(pending).toHaveLength(1);
    const fixture = pending[0]!;
    if (fixture.expected.status !== 'decision') throw new Error('Expected decision fixture');
    const candidate = validateControllerDecision(fixture.input, fixture.expected.decision);
    expect(candidate.ok).toBe(false);
    if (!candidate.ok)
      expect(candidate.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['SELECTION_PROOF_REQUIRED']);
  });

  it('publishes schemas matching strict definitions and validates artifacts independently with Ajv', async () => {
    await verifyPublishedSchemas();
    const ajv = new Ajv2020({ strict: true, strictTypes: false, formats: { 'date-time': true } });
    const schemas = publishedConformanceSchemas();
    expect((await readdir(join(corpusDirectory, 'schemas'))).sort()).toEqual(
      Object.keys(schemas)
        .map((name) => `${name}.schema.json`)
        .sort(),
    );
    for (const [name, generated] of Object.entries(schemas)) {
      const published = JSON.parse(
        await readFile(join(corpusDirectory, 'schemas', `${name}.schema.json`), 'utf8'),
      ) as object;
      expect(published).toEqual(generated);
      const validate = ajv.compile(published);
      const examples: unknown[] =
        name === 'source'
          ? sources
          : name === 'shared'
            ? [shared]
            : name === 'fixture'
              ? fixtures
              : name === 'manifest'
                ? [manifest]
                : name === 'compatibility'
                  ? [corpus.compatibility]
                  : name === 'execution-scenario'
                    ? fixtures
                        .filter((fixture) => fixture.operation === 'execution_scenario')
                        .map((fixture) => fixture.input)
                    : fixtures.map((fixture) => {
                        const request = value(buildSubjectRequest(fixture, manifest));
                        return name === 'request' ? request : response(fixture, request);
                      });
      for (const example of examples) expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it.each(fixtures.map((fixture) => [fixture.id, fixture] as const))(
    'checks a synthetic response for %s without running a subject',
    (_id, fixture) => {
      const request = value(buildSubjectRequest(fixture, manifest));
      const encoded = bytes(response(fixture, request));
      expect(validateSubjectResponse(encoded, request, subject).ok).toBe(true);
      expect(compareCaseResult(fixture, manifest, request, encoded, subject)).toEqual({ ok: true, value: true });
    },
  );

  it('requires exact inventory and paths even when the manifest is resealed', () => {
    expect(validateCorpus(manifest, null as never, corpus.compatibility).ok).toBe(false);
    for (const change of ['missing', 'extra', 'duplicate', 'escape', 'unsorted'] as const) {
      const altered = structuredClone(manifest);
      const documents = { ...corpus.fixtures };
      if (change === 'missing') delete documents['fixtures/case_001.json'];
      if (change === 'extra') documents['fixtures/case_999.json'] = fixtures[0];
      if (change === 'duplicate') altered.manifest.entries.push(structuredClone(altered.manifest.entries[0]!));
      if (change === 'escape') altered.manifest.entries[0]!.path = '../case_001.json';
      if (change === 'unsorted') altered.manifest.entries.reverse();
      altered.corpus_digest = conformanceDigest(altered.manifest);
      expect(validateCorpus(altered, documents, corpus.compatibility).ok, change).toBe(false);
    }
  });

  it('binds expectations and metadata as well as inputs; rejects substitution during comparison', () => {
    const original = fixtures.find(
      (fixture) => fixture.expected.status === 'decision' && fixture.expected.decision.decision.outcome === 'blocked',
    )!;
    const request = value(buildSubjectRequest(original, manifest));
    const changed = structuredClone(original);
    changed.title = 'HIDDEN_CASE_TITLE';
    changed.rationale = 'HIDDEN_CASE_RATIONALE';
    if (changed.expected.status !== 'decision' || changed.expected.decision.decision.outcome !== 'blocked')
      throw new Error('Expected blocked fixture');
    changed.expected.decision.decision.reasons[0]!.message = 'HIDDEN_EXPECTED_OUTCOME';
    changed.expected.decision.decision_digest = sha256(canonicalJson(changed.expected.decision.decision));
    expect(buildSubjectRequest(changed, manifest).ok).toBe(false);
    const updated = listed(changed);
    expect(updated.corpus_digest).not.toBe(manifest.corpus_digest);
    const newRequest = value(buildSubjectRequest(changed, updated));
    expect(newRequest.request.input_digest).toBe(request.request.input_digest);
    const wire = bytes(newRequest).toString();
    expect(wire).not.toMatch(
      /HIDDEN_|"expected"|"title"|"rationale"|"intent"|"references"|"coverage"|"semantic_check"|"\$fixture_ref"/,
    );
    expect(compareCaseResult(changed, updated, request, bytes(response(original, request)), subject).ok).toBe(false);
    // Informational prose may differ, but each response still needs its own correct embedded digest.
    expect(compareCaseResult(original, manifest, request, bytes(response(changed, request)), subject).ok).toBe(true);
  });

  it('changes corpus identity on fixture addition, removal, input, or expectation edits', () => {
    const removed = structuredClone(manifest);
    removed.manifest.entries.pop();
    const added = structuredClone(manifest);
    added.manifest.entries.push({ ...added.manifest.entries[0]!, id: 'case_999', path: 'fixtures/case_999.json' });
    expect(conformanceDigest(removed.manifest)).not.toBe(manifest.corpus_digest);
    expect(conformanceDigest(added.manifest)).not.toBe(manifest.corpus_digest);
    const modified = structuredClone(fixtures[0]!);
    modified.input = {};
    expect(listed(modified).corpus_digest).not.toBe(manifest.corpus_digest);
    modified.expected = { status: 'invalid', diagnostics: [{ code: 'DIFFERENT', path: '$', identifier: null }] };
    expect(listed(modified).corpus_digest).not.toBe(
      listed({ ...modified, expected: fixtures[0]!.expected }).corpus_digest,
    );
  });

  it('preserves selected claim, receipt, and human-authority expectations', () => {
    const find = (id: string) => fixtures.find((fixture) => fixture.id === id)!;
    for (const id of ['case_029', 'case_030', 'case_037', 'case_038']) {
      const result = find(id).expected;
      if (result.status !== 'execution') throw new Error('Expected execution fixture');
      expect(result.projection.claims).toHaveLength(1);
      expect(result.steps.map((step) => step.code)).toEqual([
        'CLAIM_ACQUIRED',
        ['case_037', 'case_038'].includes(id) ? 'EXECUTION_VERSION_CONFLICT' : 'CLAIM_HELD',
      ]);
    }
    const late = find('case_032').expected;
    if (late.status !== 'execution') throw new Error('Expected execution fixture');
    expect(late.projection.claims.map((claim) => claim.status)).toEqual(['replaced', 'active']);
    expect(late.projection.receipts[0]!.code).toBe('CLAIM_FENCED');
    const admitted = find('case_034').expected;
    if (admitted.status !== 'execution') throw new Error('Expected execution fixture');
    expect(admitted.projection.request_status).toBe('satisfied');
    expect(admitted.projection.controller.execution.status).toBe('idle');
    const outer = find('case_036').expected;
    if (outer.status !== 'decision') throw new Error('Expected decision fixture');
    expect(outer.decision.decision.outcome).toBe('engineering_action_required');
    for (const fixture of fixtures.filter((fixture) => fixture.coverage.includes('human_completion'))) {
      if (fixture.expected.status !== 'decision') throw new Error('Expected decision fixture');
      const decision = fixture.expected.decision.decision;
      if (decision.outcome === 'human_action_required') expect(decision.action_request.request.actor).toBe('human');
      else expect(decision.outcome).toBe('transition_available');
    }
  });
});

describe('Fail-closed response and version contracts', () => {
  const fixture = fixtures[0]!;
  const request = value(buildSubjectRequest(fixture, manifest));
  it.each(['protocol', 'schema', 'fixture_schema', 'canonicalization', 'digest_profile'] as const)(
    'rejects independently unsupported %s',
    (field) => {
      const changed = structuredClone(request);
      Object.assign(changed.request, { [field]: 'unsupported/99' });
      changed.request_digest = conformanceDigest(changed.request);
      expect(validateSubjectResponse(bytes(response(fixture, changed)), changed, subject).ok).toBe(false);
      const result = response(fixture, request);
      Object.assign(result.response, { [field]: 'unsupported/99' });
      result.response_digest = conformanceDigest(result.response);
      expect(validateSubjectResponse(bytes(result), request, subject).ok).toBe(false);
    },
  );

  it('refuses wrong subject, wrong request, unknown fields, or corrupted envelopes', () => {
    const good = response(fixture, request);
    expect(validateSubjectResponse(bytes(good), request, { ...subject, revision: 'different' }).ok).toBe(false);
    const wrong = response(fixture, request);
    wrong.response.request_digest = '0'.repeat(64);
    wrong.response_digest = conformanceDigest(wrong.response);
    expect(validateSubjectResponse(bytes(wrong), request, subject).ok).toBe(false);
    expect(validateSubjectResponse(bytes({ ...good, note: 'unknown' }), request, subject).ok).toBe(false);
    expect(validateSubjectResponse(bytes({ ...good, response_digest: '0'.repeat(64) }), request, subject).ok).toBe(
      false,
    );
    expect(validateSubjectResponse(bytes(good), { ...request, request_digest: '0'.repeat(64) }, subject).ok).toBe(
      false,
    );
    expect(validateSubjectResponse(bytes(good), request, { ...subject, version: '' }).ok).toBe(false);
  });

  it('rejects resealed nested-domain tampering and structurally valid incorrect outcomes', () => {
    const changed = response(fixture, request);
    if (changed.response.result.status !== 'compiled') throw new Error('Expected graph');
    changed.response.result.compiled_graph.graph_digest = '0'.repeat(64);
    changed.response_digest = conformanceDigest(changed.response);
    expect(validateSubjectResponse(bytes(changed), request, subject).ok).toBe(false);
    const decisionFixture = fixtures.find((fixture) => fixture.id === 'case_004')!;
    const decisionRequest = value(buildSubjectRequest(decisionFixture, manifest));
    const candidate = response(decisionFixture, decisionRequest);
    if (candidate.response.result.status !== 'decision') throw new Error('Expected decision');
    candidate.response.result.decision.decision_digest = '0'.repeat(64);
    candidate.response_digest = conformanceDigest(candidate.response);
    expect(validateSubjectResponse(bytes(candidate), decisionRequest, subject).ok).toBe(false);
  });

  it('bounds hostile object inputs and byte frames before recursive schema work', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const input of [
      cyclic,
      { value: -0 },
      { value: 1.5 },
      { value: Number.MAX_SAFE_INTEGER + 1 },
      { value: '\ud800' },
    ]) {
      expect(buildSubjectRequest(input, manifest).ok).toBe(false);
    }
    const accessor = Object.defineProperty({}, 'value', {
      enumerable: true,
      get() {
        throw new Error('Must not execute');
      },
    });
    expect(buildSubjectRequest(accessor, manifest).ok).toBe(false);
    expect(parseConformanceMessage(new Uint8Array(16 * 1024 * 1024 + 2)).ok).toBe(false);
    let deep: unknown = null;
    for (let index = 0; index < 66; index++) deep = [deep];
    expect(canonicalConformanceJson(deep).ok).toBe(false);
  });
});

describe('Read-only fixture loader', () => {
  it('rejects duplicate keys, unexpected files, and symlinks instead of following them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'threadloop-conformance-'));
    try {
      await mkdir(join(directory, 'fixtures'));
      const single = structuredClone(manifest);
      single.manifest.entries = single.manifest.entries.slice(0, 1);
      single.corpus_digest = conformanceDigest(single.manifest);
      await writeFile(join(directory, 'manifest.json'), JSON.stringify(single));
      await writeFile(join(directory, 'shared.json'), JSON.stringify(shared));
      await writeFile(join(directory, 'compatibility.json'), JSON.stringify(corpus.compatibility));
      const path = join(directory, 'fixtures', 'case_001.json');
      await writeFile(path, '{"id":"case_001","id":"case_002"}');
      await expect(loadCorpus(directory)).rejects.toThrow('Duplicate');
      await rm(path);
      await symlink(join(directory, 'manifest.json'), path);
      await expect(loadCorpus(directory)).rejects.toThrow('regular');
      await rm(path);
      await writeFile(join(directory, 'fixtures', 'unexpected.json'), '{}');
      await expect(loadCorpus(directory)).rejects.toThrow('Unlisted');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('Independent canonical golden vectors', () => {
  it('matches independently authored bytes, framing, and nested legacy identity', async () => {
    const golden = JSON.parse(await readFile(join(corpusDirectory, 'vectors/golden.json'), 'utf8')) as {
      vectors: { value: unknown; canonical: string; digest: string }[];
      request_digest: string;
      response_digest: string;
      legacy_graph_digest: string;
    };
    for (const vector of golden.vectors) {
      expect(value(canonicalConformanceJson(vector.value))).toBe(vector.canonical);
      expect(conformanceDigest(vector.value)).toBe(vector.digest);
    }
    const request = value(buildSubjectRequest(fixtures[0], manifest));
    const requestBytes = await readFile(join(corpusDirectory, 'vectors/request.canonical'));
    expect(bytes(request)).toEqual(requestBytes);
    expect(request.request_digest).toBe(golden.request_digest);
    const responseBytes = await readFile(join(corpusDirectory, 'vectors/response.canonical'));
    const result = value(validateSubjectResponse(responseBytes, request, subject));
    expect(result.response_digest).toBe(golden.response_digest);
    expect(value(validateSubjectResponse(Buffer.concat([responseBytes, Buffer.from('\n')]), request, subject))).toEqual(
      result,
    );
    if (result.response.result.status !== 'compiled') throw new Error('Expected compiled graph');
    expect(result.response.result.compiled_graph.graph_digest).toBe(golden.legacy_graph_digest);
  });

  it('documents a real ambiguity and retains its unsupported selection check', () => {
    const fixture = fixtures.find((fixture) => fixture.semantic_check === 'selection_pending')!;
    const input = fixture.input as {
      compiled_graph: {
        graph: {
          guards: { id: string; required_actions: string[] }[];
          required_actions: { id: string; capability: string; authority: string; parameters: unknown }[];
        };
      };
      receipts: unknown[];
    };
    const graph = input.compiled_graph.graph;
    const actions = graph.required_actions.filter(
      (action) =>
        graph.guards.find((guard) => guard.id === 'review_set')!.required_actions.includes(action.id) &&
        action.capability === 'run_local_gates',
    );
    expect(actions.map((action) => action.id)).toEqual(['run_gates', 'run_gates_alternative']);
    expect(
      actions.map((action) => ({
        capability: action.capability,
        authority: action.authority,
        parameters: action.parameters,
      }))[0],
    ).toEqual(
      actions.map((action) => ({
        capability: action.capability,
        authority: action.authority,
        parameters: action.parameters,
      }))[1],
    );
    expect(input.receipts).toEqual([]);
  });
});

describe('Negative domain documents and independent artifact versions', () => {
  it('transmits intentionally invalid domain versions without leaking the expected rejection', () => {
    const fixture = structuredClone(fixtures.find((item) => item.id === 'case_004')!);
    Object.assign(fixture.input as object, { schema_version: '99' });
    fixture.expected = {
      status: 'invalid',
      diagnostics: [{ code: 'UNSUPPORTED_VERSION', path: '$.schema_version', identifier: null }],
    };
    const updated = listed(fixture);
    const request = value(buildSubjectRequest(fixture, updated));
    expect(bytes(request).toString()).not.toContain('UNSUPPORTED_VERSION');
    expect(compareCaseResult(fixture, updated, request, bytes(response(fixture, request)), subject).ok).toBe(true);
  });

  it('rejects fixture, manifest, and compatibility format drift independently', () => {
    const changedFixture = { ...fixtures[0], schema: 'threadloop.conformance-fixture/99' };
    expect(buildSubjectRequest(changedFixture, manifest).ok).toBe(false);
    const changedManifest = structuredClone(manifest);
    Object.assign(changedManifest.manifest, { schema: 'threadloop.conformance-manifest/99' });
    changedManifest.corpus_digest = conformanceDigest(changedManifest.manifest);
    expect(validateCorpus(changedManifest, corpus.fixtures, corpus.compatibility).ok).toBe(false);
    const changedCompatibility = {
      ...(corpus.compatibility as object),
      schema: 'threadloop.conformance-compatibility/99',
    };
    const resealed = structuredClone(manifest);
    resealed.manifest.compatibility_digest = conformanceDigest(changedCompatibility);
    resealed.corpus_digest = conformanceDigest(resealed.manifest);
    expect(validateCorpus(resealed, corpus.fixtures, changedCompatibility).ok).toBe(false);
  });
});

describe('Qodo artifact-integrity regressions', () => {
  it('rejects duplicate published-schema keys even when ordinary JSON parsing matches the definition (e042b489)', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'threadloop-schema-keys-'));
    try {
      await mkdir(join(directory, 'schemas'));
      for (const [name, schema] of Object.entries(publishedConformanceSchemas())) {
        let source = JSON.stringify(schema);
        if (name === 'request') source = '{"type":"string",' + source.slice(1);
        await writeFile(join(directory, 'schemas', `${name}.schema.json`), source);
        expect(JSON.parse(source)).toEqual(schema);
      }
      await expect(verifyPublishedSchemas(directory)).rejects.toThrow('Duplicate');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects compatibility-schema symlinks even when their target has the pinned bytes (7f7b3946)', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'threadloop-compatibility-links-'));
    try {
      const compatibility = compatibilitySchema.parse(corpus.compatibility);
      for (const contract of compatibility.contracts) {
        const target = join(directory, `${contract.name}-v0.1`, 'schemas');
        await mkdir(target, { recursive: true });
        for (const schema of contract.schemas) {
          await writeFile(
            join(target, schema.path),
            await readFile(join(corpusDirectory, '..', `${contract.name}-v0.1`, 'schemas', schema.path)),
          );
        }
      }
      await verifyCompatibility(compatibility, directory);
      const contract = compatibility.contracts[0]!;
      const path = join(directory, `${contract.name}-v0.1`, 'schemas', contract.schemas[0]!.path);
      const target = join(directory, 'matching-schema.json');
      await writeFile(target, await readFile(path));
      await rm(path);
      await symlink(target, path);
      await expect(verifyCompatibility(compatibility, directory)).rejects.toThrow('regular');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('Compact corpus regression', () => {
  it('preserves every frozen fixture identity and keeps reviewed source data below 384 KiB', async () => {
    // Identity from the original, fully materialized corpus at 49fbf87. Never regenerated by this test.
    expect(manifest.corpus_digest).toBe('11620588c6f4b39353ea9f77e361a50b5cb0dc970410b1ac10aa8bef13efad84');
    expect(validateCorpus(manifest, corpus.fixtures, corpus.compatibility).ok).toBe(true);
    let bytes = (await readFile(join(corpusDirectory, 'shared.json'))).length;
    for (const name of await readdir(join(corpusDirectory, 'fixtures')))
      bytes += (await readFile(join(corpusDirectory, 'fixtures', name))).length;
    expect(bytes).toBeLessThan(384 * 1024);
    for (const fixture of fixtures) {
      const wire = value(canonicalConformanceJson(value(buildSubjectRequest(fixture, manifest))));
      expect(wire).not.toContain('"$fixture_ref"');
      expect(wire).not.toContain('threadloop.conformance-source');
    }
  });
});

describe('Shared artifact integrity', () => {
  it.each(['changed', 'missing', 'duplicate-key', 'symlink', 'unused', 'oversized', 'unlisted'])(
    'rejects a %s shared artifact without changing committed data',
    async (mutation) => {
      const directory = await mkdtemp(join(tmpdir(), 'threadloop-shared-'));
      try {
        await cp(corpusDirectory, directory, { recursive: true });
        const path = join(directory, 'shared.json');
        const document = JSON.parse(await readFile(path, 'utf8')) as {
          schema: string;
          values: Record<string, unknown>;
        };
        if (mutation === 'changed') document.values[Object.keys(document.values)[0]!] = null;
        if (mutation === 'unused') document.values.unused = null;
        await writeFile(path, JSON.stringify(document));
        if (mutation === 'missing') await rm(path);
        if (mutation === 'oversized') await writeFile(path, Buffer.alloc(2 * 1024 * 1024 + 1));
        if (mutation === 'unlisted') await writeFile(join(directory, 'fixtures/case_999.json'), 'NOT JSON');
        if (mutation === 'duplicate-key')
          await writeFile(path, '{"schema":"duplicate",' + JSON.stringify(document).slice(1));
        if (mutation === 'symlink') {
          await rm(path);
          await symlink(join(corpusDirectory, 'shared.json'), path);
        }
        const check = async () => {
          const loaded = await loadCorpus(directory);
          value(validateCorpus(loaded.manifest, loaded.fixtures, loaded.compatibility));
        };
        await expect(check()).rejects.toThrow(
          mutation === 'unlisted' ? /Unlisted/ : mutation === 'oversized' ? /source-byte limit/ : undefined,
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});

it('published request, fixture and scenario schemas enforce canonical numeric bounds (79286eab)', () => {
  const ajv = new Ajv2020({ strict: true, strictTypes: false, formats: { 'date-time': true } });
  const schemas = publishedConformanceSchemas();
  const request = value(buildSubjectRequest(fixtures[0], manifest));
  const execution = fixtures.find((fixture) => fixture.operation === 'execution_scenario')!;
  for (const number of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const malformedRequest = { ...request, request: { ...request.request, input: { nested: [number] } } };
    const malformedFixture = { ...fixtures[0], input: { nested: [number] } };
    const malformedScenario = { ...(execution.input as object), projection_snapshot: { nested: [number] } };
    for (const [name, schema, document] of [
      ['request', requestSchema, malformedRequest],
      ['fixture', fixtureSchema, malformedFixture],
      ['execution-scenario', executionScenarioSchema, malformedScenario],
    ] as const) {
      expect(schema.safeParse(document).success).toBe(false);
      expect(ajv.compile(schemas[name]!)(document)).toBe(false);
    }
  }
});

it('admits only exact authority facts with a large irrelevant digest list (bcbea046)', () => {
  const fixture = structuredClone(fixtures.find((item) => item.id === 'case_034')!);
  const input = executionScenarioSchema.parse(fixture.input);
  input.admitted_digests.push(...Array.from({ length: 4096 }, (_, index) => index.toString(16).padStart(64, '0')));
  fixture.input = input;
  const altered = { ...corpus.fixtures, 'fixtures/case_034.json': fixture };
  expect(validateCorpus(listed(fixture), altered, corpus.compatibility).ok).toBe(true);
});
