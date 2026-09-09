import { describe, expect, it, vi } from 'vitest';
import * as cryptoAdapter from '../../src/adapters/crypto/sha256.js';
import {
  applyExecutionOperation,
  executionDigest,
  replayExecutionJournal,
} from '../../scripts/execution-contract/model.js';
import { executionLimits } from '../../scripts/execution-contract/limits.js';
import { initialExecution, grant, executorA, operationFor, operate } from '../fixtures/execution-contract.js';

describe('Bounded execution replay', () => {
  it('can substitute incremental hashing through the crypto adapter during replay', async () => {
    const { journal } = await initialExecution();
    const factory = vi.spyOn(cryptoAdapter, 'createIncrementalSha256').mockImplementation(() => {
      let prefix = '';
      return {
        update(value: string) {
          prefix += value;
        },
        digest(suffix = '') {
          return cryptoAdapter.sha256(prefix + suffix);
        },
      };
    });
    try {
      const claimed = operate(journal, grant);
      const started = operate(claimed.journal, {
        kind: 'start',
        claim: { id: 'claim_a', version: 1 },
        attempt_id: 'attempt_a',
      });
      const released = operate(started.journal, {
        kind: 'release',
        claim: { id: 'claim_a', version: 1 },
        attempt_id: 'attempt_a',
      });
      expect(released.result.code).toBe('CLAIM_RELEASED');
      expect(released.projection.attempts[0]?.status).toBe('unknown_outcome');
      expect(factory).toHaveBeenCalled();
    } finally {
      factory.mockRestore();
    }
  });

  it('stops reading object properties as soon as the resource budget is exhausted', () => {
    const later = vi.fn(() => {
      throw new Error('An over-budget input must not read remaining values');
    });
    const input = Object.defineProperty({ first: 'x'.repeat(executionLimits.jsonBytes + 1) }, 'later', {
      enumerable: true,
      get: later,
    });
    const authority = { isAdmitted: vi.fn(() => true) };
    expect(replayExecutionJournal(input, authority)).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'EXECUTION_INPUT_LIMIT' }],
    });
    expect(later).not.toHaveBeenCalled();
    expect(authority.isAdmitted).not.toHaveBeenCalled();
  });

  it('replays a full journal with one authority check per entry and preserves duplicate grant results', async () => {
    const { journal, context } = await initialExecution();
    context.actor = { kind: 'executor', executor: executorA };
    // The fixture authority explicitly admits this synthetic history. Authentication is
    // exercised separately against an independent allowlist in execution-authority.test.ts.
    const authority = { isAdmitted: vi.fn(() => true) };
    for (let i = 0; i < executionLimits.journalEntries; i++) {
      const operation = operationFor(journal, context.actor, grant, `delivery_${i}`);
      journal.execution.entries.push({ context, operation });
    }
    journal.execution_digest = executionDigest(journal.execution);
    const replayed = replayExecutionJournal(journal, authority);
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    expect(authority.isAdmitted).toHaveBeenCalledTimes(executionLimits.journalEntries + 1);
    expect(replayed.value.claims).toHaveLength(1);
    expect(replayed.value.attempts).toHaveLength(1);
    expect(replayed.value.operations).toHaveLength(executionLimits.journalEntries);
    expect(
      replayed.value.operations.every((item) => item.result.code === 'CLAIM_ACQUIRED' && item.result.revision === 1),
    ).toBe(true);
    const last = journal.execution.entries.at(-1)!;
    const exact = applyExecutionOperation(journal, context, last.operation, authority);
    expect(exact.ok && exact.value.replayed).toBe(true);
    expect(exact.ok && exact.value.journal).toEqual(journal);
    const full = applyExecutionOperation(
      journal,
      context,
      operationFor(journal, context.actor, grant, 'one_more_delivery'),
      authority,
    );
    expect(full).toMatchObject({ ok: false, diagnostics: [{ code: 'EXECUTION_INPUT_LIMIT' }] });
    expect(journal.execution.entries).toHaveLength(executionLimits.journalEntries);
  });

  it('keeps canonical prefix hashes compatible through fresh CAS mutations', async () => {
    const { journal } = await initialExecution();
    let current = operate(journal, grant);
    for (let minute = 6; minute < 15; minute++) {
      current = operate(current.journal, {
        kind: 'renew',
        claim: { id: 'claim_a', version: 1 },
        attempt_id: 'attempt_a',
        valid_until: `2026-09-10T10:${String(minute).padStart(2, '0')}:00.000Z`,
      });
      expect(current.result.code).toBe('CLAIM_RENEWED');
      expect(current.journal.execution_digest).toBe(executionDigest(current.journal.execution));
    }
    expect(current.projection.claims).toHaveLength(1);
  });

  it('refuses oversized or deeply nested input before authority checks or replay', async () => {
    const { journal } = await initialExecution();
    const authority = { isAdmitted: vi.fn(() => true) };
    const tooMany = structuredClone(journal);
    const entry = {
      context: journal.execution.initial_context,
      operation: operationFor(journal, journal.execution.initial_context.actor, grant),
    };
    tooMany.execution.entries = Array.from({ length: executionLimits.journalEntries + 1 }, () => entry);
    let nested: unknown = null;
    for (let i = 0; i <= executionLimits.depth; i++) nested = [nested];
    for (const input of [tooMany, nested, 'x'.repeat(executionLimits.jsonBytes + 1)]) {
      expect(replayExecutionJournal(input, authority)).toMatchObject({
        ok: false,
        diagnostics: [{ code: 'EXECUTION_INPUT_LIMIT' }],
      });
    }
    expect(authority.isAdmitted).not.toHaveBeenCalled();
  });
});
