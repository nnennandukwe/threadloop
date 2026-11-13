import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { canonicalExecutorJson } from 'threadloop-contracts/executor';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import { canonicalGaapJson, parseGaapJson } from '../../src/domain/gaap-json.js';

const parse = (text: string) => parseGaapJson(Buffer.from(text));

describe('bounded authenticated JSON decoding', () => {
  it.each([
    '{"a":1,"a":2}',
    '{"a":1,"\\u0061":2}',
    '{"a":{"b":1,"b":2}}',
    '{"a":1} {}',
    '\ufeff{}',
    '"\\ud800"',
    '{"\\udc00":1}',
    '1e400',
    '1e-324',
    '-1e-324',
    '9007199254740993',
    '[1,]',
    '{"a":1,}',
    '00',
    'truefalse',
    '"\\x20"',
    '"line\nbreak"',
  ])('rejects %j', (text) => {
    expect(() => parse(text)).toThrow();
  });
  it('preserves ordinary JSON values and safely retains prototype-named keys', () => {
    const text = String.raw`{"a":[null,true,false,1.25,-2,"x\"y"],"__proto__":{"safe":true}}`;
    expect(parse(text)).toEqual(JSON.parse(text));
    expect({}).not.toHaveProperty('safe');
  });
  it('preserves zero and the smallest representable nonzero value', () => {
    expect(parse('0e-324')).toBe(0);
    expect(parse('5e-324')).toBe(Number.MIN_VALUE);
  });

  it('rejects malformed UTF-8, excessive nesting and input bytes', () => {
    expect(() => parseGaapJson(Uint8Array.from([0xc0, 0xaf]))).toThrow('UTF-8');
    expect(() => parse('['.repeat(66) + '0' + ']'.repeat(66))).toThrow();
    expect(() => parseGaapJson(Buffer.from('{}'), { maxBytes: 1 })).toThrow('byte limit');
  });
});

it('shares canonical wire vectors with the pinned accepted conformance corpus', async () => {
  const asset = import.meta.resolve('threadloop-contracts/assets/controller-conformance-v0.1/vectors/golden.json');
  const corpus = JSON.parse(await readFile(new URL(asset), 'utf8')) as {
    vectors: Array<{ value: unknown; canonical: string; digest: string }>;
  };
  for (const vector of corpus.vectors) {
    const wire = canonicalExecutorJson(vector.value);
    expect(wire).toEqual({ ok: true, value: vector.canonical });
    expect(canonicalGaapJson(vector.value)).toBe(vector.canonical);
    expect(sha256(vector.canonical)).toBe(vector.digest);
  }
});
