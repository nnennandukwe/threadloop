import { Ajv2020 } from 'ajv/dist/2020.js';
import {
  fixtureSourceSchema,
  sharedValuesSchema,
  publishedConformanceSchemas,
} from '../../scripts/controller-conformance/contracts.js';
import { describe, expect, it } from 'vitest';
import { materializeFixtureSources } from '../../scripts/controller-conformance/sources.js';

const source = (fixture: unknown) => ({ schema: 'threadloop.conformance-source/0.1', fixture });
const shared = (values: Record<string, unknown>) => ({ schema: 'threadloop.conformance-shared/0.1', values });
const ref = (name: string) => ({ $fixture_ref: name });

describe('Portable fixture sources', () => {
  it('expands literal data without merging, evaluating recipes, or aliasing shared objects', () => {
    const sources = { 'fixtures/case_001.json': source({ input: [ref('snapshot'), ref('snapshot')] }) };
    const values = shared({ snapshot: { graph: ref('graph'), revision: 3 }, graph: { states: ['ready'] } });
    const before = structuredClone({ sources, values });
    const result = materializeFixtureSources(sources, values);
    expect(result).toEqual({
      'fixtures/case_001.json': {
        input: [
          { graph: { states: ['ready'] }, revision: 3 },
          { graph: { states: ['ready'] }, revision: 3 },
        ],
      },
    });
    const input = (result['fixtures/case_001.json'] as { input: object[] }).input;
    expect(input[0]).not.toBe(input[1]);
    expect({ sources, values }).toEqual(before);
  });

  it.each([
    ['missing reference', { input: ref('missing') }, {}, /missing/],
    ['external reference', { input: ref('../elsewhere.json') }, {}, /reference/],
    ['reference with overrides', { input: { ...ref('graph'), extra: true } }, { graph: {} }, /reference/],
    ['self cycle', ref('loop'), { loop: ref('loop') }, /cycle/],
    ['indirect cycle', ref('first'), { first: ref('second'), second: ref('first') }, /cycle/],
    ['unused value', {}, { unused: {} }, /unused/],
    ['inherited name', ref('constructor'), {}, /reference/],
  ])('rejects %s with actionable source diagnostics', (_name, fixture, values, error) => {
    expect(() =>
      materializeFixtureSources(
        { 'fixtures/case_001.json': source(fixture) },
        shared(values as Record<string, unknown>),
      ),
    ).toThrow(error);
  });

  it('rejects independent storage versions, extra fields, and invalid source JSON', () => {
    expect(() => materializeFixtureSources({ test: { ...source({}), schema: 'unknown' } }, shared({}))).toThrow();
    expect(() => materializeFixtureSources({ test: source({}) }, { ...shared({}), schema: 'unknown' })).toThrow();
    expect(() => materializeFixtureSources({ test: { ...source({}), extra: true } }, shared({}))).toThrow();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => materializeFixtureSources({ test: source(cyclic) }, shared({}))).toThrow();
  });

  it('bounds expansion before a small reference tree becomes an oversized document', () => {
    const values: Record<string, unknown> = { leaf: 'x'.repeat(1024) };
    let name = 'leaf';
    for (let index = 0; index < 20; index++) {
      values[`level_${index}`] = [ref(name), ref(name)];
      name = `level_${index}`;
    }
    expect(() => materializeFixtureSources({ test: source(ref(name)) }, shared(values))).toThrow(/limit/);
    values.leaf = null;
    values.level_20 = [ref(name), ref(name)];
    expect(() => materializeFixtureSources({ test: source(ref('level_20')) }, shared(values))).toThrow(/limit/);
    const deep: Record<string, unknown> = { leaf: null };
    name = 'leaf';
    for (let index = 0; index < 66; index++) {
      deep[`level_${index}`] = ref(name);
      name = `level_${index}`;
    }
    expect(() => materializeFixtureSources({ test: source(ref(name)) }, shared(deep))).toThrow(/limit/);
  });
});

it('Zod and published Ajv schemas reject malformed reference objects consistently', () => {
  const ajv = new Ajv2020({ strict: true });
  const schemas = publishedConformanceSchemas();
  const sourceValidator = ajv.compile(schemas.source!);
  const sharedValidator = ajv.compile(schemas.shared!);
  for (const invalid of [
    { $fixture_ref: 'graph', extra: true },
    { $fixture_ref: 1 },
    { $fixture_ref: '../graph' },
    { nested: [{ $fixture_ref: null }] },
  ]) {
    expect(fixtureSourceSchema.safeParse(source(invalid)).success).toBe(false);
    expect(sourceValidator(source(invalid))).toBe(false);
    expect(sharedValuesSchema.safeParse(shared({ graph: invalid })).success).toBe(false);
    expect(sharedValidator(shared({ graph: invalid }))).toBe(false);
  }
  expect(sourceValidator(source({ '$fixture_ref\n': null }))).toBe(true);
  expect(fixtureSourceSchema.safeParse(source({ '$fixture_ref\n': null })).success).toBe(true);
  expect(sourceValidator(source({ nested: [ref('graph'), { name: 'literal' }] }))).toBe(true);
});

it('bounds total expansion across individually bounded cases (c8752963, 66bba7a2)', () => {
  const values: Record<string, unknown> = { leaf: 'x'.repeat(1024) };
  let name = 'leaf';
  for (let index = 0; index < 13; index++) {
    values[`level_${index}`] = [ref(name), ref(name)];
    name = `level_${index}`;
  }
  const one = source(ref(name));
  expect(() => materializeFixtureSources({ first: one }, shared(values))).not.toThrow();
  expect(() => materializeFixtureSources({ first: one, second: one }, shared(values))).toThrow(/byte limit/);
});
