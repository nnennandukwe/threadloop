import { describe, expect, it } from 'vitest';
import { parseExecutorMessage } from '../../scripts/executor-contract/codec.js';

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
    '',
    '{"a":1,"a":2}',
    '{"b":1,"a":2}',
    '{ "a":1}',
    '{"a":1}\n\n',
    '{"a":1}\r\n',
    '{"a":1}\n{"a":2}',
    '{"a":9007199254740992}',
    '{"a":1.5}',
    '{"a":-0}',
    '{"a":-1}',
    '{"a":"\\ud800"}',
    '{"a":1} log',
  ])('rejects malformed or noncanonical input %s', (source) => {
    expect(parseExecutorMessage(Buffer.from(source)).ok).toBe(false);
  });
  it('rejects malformed UTF-8 and a byte-order mark', () => {
    expect(parseExecutorMessage(Uint8Array.from([0xc0, 0xaf])).ok).toBe(false);
    expect(parseExecutorMessage(Buffer.from('\ufeff{}')).ok).toBe(false);
  });
  it('bounds input bytes and nesting before recursive schema work', () => {
    expect(parseExecutorMessage(Buffer.alloc(16 * 1024 * 1024 + 2, 32)).ok).toBe(false);
    expect(parseExecutorMessage(Buffer.from('['.repeat(66) + '0' + ']'.repeat(66))).ok).toBe(false);
  });
});
