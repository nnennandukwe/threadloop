import { describe, expect, it } from 'vitest';
import {
  canonicalExecutorJson,
  parseExecutorMessage,
  validateJsonValue,
} from '../../scripts/executor-contract/codec.js';
import { codes } from '../fixtures/contracts.js';

describe('Executor process framing', () => {
  it('accepts canonical UTF-8 with one optional terminal LF', () => {
    for (const suffix of ['', '\n']) {
      expect(parseExecutorMessage(Buffer.from('{"count":9007199254740991,"items":[1,0]}' + suffix))).toEqual({
        ok: true,
        value: { count: Number.MAX_SAFE_INTEGER, items: [1, 0] },
      });
    }
  });
  it.each([
    ['', 'INVALID_JSON'],
    ['{"a":1,"a":2}', 'NONCANONICAL_JSON'],
    ['{"b":1,"a":2}', 'NONCANONICAL_JSON'],
    ['{ "a":1}', 'NONCANONICAL_JSON'],
    ['{"a":1}\n\n', 'NONCANONICAL_JSON'],
    ['{"a":1}\r\n', 'NONCANONICAL_JSON'],
    ['{"a":1}\n{"a":2}', 'INVALID_JSON'],
    ['{"a":9007199254740992}', 'INVALID_JSON_VALUE'],
    ['{"a":1.5}', 'INVALID_JSON_VALUE'],
    ['{"a":-0}', 'INVALID_JSON_VALUE'],
    ['{"a":-1}', 'INVALID_JSON_VALUE'],
    ['{"a":"\\ud800"}', 'INVALID_JSON_VALUE'],
    ['{"a":1} log', 'INVALID_JSON'],
    ['\ufeff{}', 'INVALID_JSON'],
  ])('rejects malformed or noncanonical input %j', (source, code) => {
    expect(codes(parseExecutorMessage(Buffer.from(source)))).toEqual([code]);
  });
  it('rejects malformed UTF-8', () => {
    expect(codes(parseExecutorMessage(Uint8Array.from([0xc0, 0xaf])))).toEqual(['INVALID_UTF8']);
  });
  it('bounds input bytes and nesting before recursive schema work', () => {
    expect(codes(parseExecutorMessage(Buffer.alloc(16 * 1024 * 1024 + 2, 32)))).toEqual(['EXECUTOR_INPUT_LIMIT']);
    expect(codes(parseExecutorMessage(Buffer.from('['.repeat(66) + '0' + ']'.repeat(66))))).toEqual([
      'EXECUTOR_INPUT_LIMIT',
    ]);
  });
  it('accepts exactly one million JSON values including an array root', () => {
    expect(validateJsonValue(Array.from({ length: 999_999 }, () => 0)).ok).toBe(true);
  });
  it('rejects one million array elements because the root also counts as a JSON value', () => {
    expect(codes(validateJsonValue(Array.from({ length: 1_000_000 }, () => 0)))).toEqual(['EXECUTOR_INPUT_LIMIT']);
  });
});

describe('Hostile in-memory values', () => {
  it.each(['null', 'custom', 'subclass'])('rejects %s array prototypes without executing inherited code', (kind) => {
    const array: unknown[] = [1, 2];
    let called = false;
    class ArraySubclass extends Array<unknown> {}
    const prototype =
      kind === 'null'
        ? null
        : kind === 'subclass'
          ? ArraySubclass.prototype
          : (Object.create(Array.prototype) as object);
    if (prototype)
      Object.defineProperty(prototype, 'map', {
        value: () => {
          called = true;
          throw new Error('Inherited map executed');
        },
      });
    Object.setPrototypeOf(array, prototype);
    expect(codes(canonicalExecutorJson(array))).toEqual(['INVALID_JSON_VALUE']);
    expect(called).toBe(false);
  });
  it('rejects proxies, cycles, and accessors before invoking object traps or getters', () => {
    let called = false;
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          called = true;
          throw new Error('Proxy trap executed');
        },
      },
    );
    const revoked = Proxy.revocable([], {});
    revoked.revoke();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const accessor = Object.defineProperty({}, 'value', {
      enumerable: true,
      get() {
        called = true;
        throw new Error('Getter executed');
      },
    });
    for (const value of [proxy, revoked.proxy, cyclic, accessor])
      expect(codes(canonicalExecutorJson(value))).toEqual(['INVALID_JSON_VALUE']);
    expect(called).toBe(false);
  });
});
