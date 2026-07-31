import { describe, expect, it } from 'vitest';
import {
  classifyGateOutcome,
  type GateProcessResult,
  type SetupStepExecution,
} from '../../src/adapters/process/gate-runner.js';
import type { GateReceiptResult } from '../../src/domain/proof.js';

function processResult(result: GateReceiptResult, exitStatus: number | null = null): GateProcessResult {
  return {
    result,
    startedAt: '2026-07-31T00:00:00.000Z',
    endedAt: '2026-07-31T00:00:01.000Z',
    durationMs: 1_000,
    exitStatus,
    signal: null,
    stdout: { sha256: 'a'.repeat(64), bytes: 0 },
    stderr: { sha256: 'b'.repeat(64), bytes: 0 },
    error: null,
  };
}

function step(id: string, result: GateReceiptResult, clean = true): SetupStepExecution {
  return {
    id,
    command: ['uv', 'sync', '--frozen'],
    timeoutMs: 600_000,
    process: processResult(result, result === 'passed' ? 0 : 1),
    headBefore: 'c'.repeat(40),
    headAfter: 'c'.repeat(40),
    cleanBefore: true,
    cleanAfter: clean,
  };
}

describe('gate outcome classification', () => {
  it('reports the gate result when no setup was declared', () => {
    expect(classifyGateOutcome({ setup: [], gate: processResult('passed', 0), invalidated: false })).toBe('passed');
    expect(classifyGateOutcome({ setup: [], gate: processResult('failed', 1), invalidated: false })).toBe('failed');
  });

  it('reports the gate result when every declared setup step passed', () => {
    expect(
      classifyGateOutcome({ setup: [step('sync', 'passed')], gate: processResult('passed', 0), invalidated: false }),
    ).toBe('passed');
    expect(
      classifyGateOutcome({ setup: [step('sync', 'passed')], gate: processResult('failed', 1), invalidated: false }),
    ).toBe('failed');
  });

  it.each(['failed', 'timed_out', 'execution_error', 'aborted', 'cleanup_failed'] as const)(
    'classifies a %s setup step as setup_failed rather than a code failure',
    (stepResult) => {
      expect(classifyGateOutcome({ setup: [step('sync', stepResult)], gate: null, invalidated: false })).toBe(
        'setup_failed',
      );
    },
  );

  it('classifies setup failure even when an earlier step passed', () => {
    expect(
      classifyGateOutcome({
        setup: [step('toolchain', 'passed'), step('sync', 'failed')],
        gate: null,
        invalidated: false,
      }),
    ).toBe('setup_failed');
  });

  it('prefers invalidated over setup_failed, because evidence integrity outranks classification', () => {
    expect(classifyGateOutcome({ setup: [step('sync', 'failed')], gate: null, invalidated: true })).toBe('invalidated');
  });

  it('prefers invalidated over a passing gate', () => {
    expect(
      classifyGateOutcome({ setup: [step('sync', 'passed')], gate: processResult('passed', 0), invalidated: true }),
    ).toBe('invalidated');
  });

  it('reports execution_error when setup passed but the gate command did not run', () => {
    expect(classifyGateOutcome({ setup: [step('sync', 'passed')], gate: null, invalidated: false })).toBe(
      'execution_error',
    );
  });
});
