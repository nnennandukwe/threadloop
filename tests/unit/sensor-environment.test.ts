import { describe, expect, it } from 'vitest';
import {
  gateSensorContext,
  positiveIntegerEnvironment,
  requiredEnvironment,
} from '../../scripts/sensor-environment.js';

const setupGate = {
  id: 'unit',
  setup: [{ id: 'install', command: ['npm', 'ci'], working_directory: '.', timeout_ms: 60_000 }],
  command: ['npm', 'test'],
  working_directory: '.',
  timeout_ms: 60_000,
};

function gateEnvironment(gate: unknown = setupGate) {
  return {
    THREADLOOP_SESSION_ID: 'session_abc',
    THREADLOOP_PLAN_SHA256: 'a'.repeat(64),
    THREADLOOP_GATE_ID: 'unit',
    THREADLOOP_GATE_JSON: JSON.stringify(gate),
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: 'b'.repeat(40),
    GITHUB_RUN_ID: '7',
    GITHUB_RUN_ATTEMPT: '1',
  };
}

describe('sensor environment parsing', () => {
  it('returns a required environment value', () => {
    expect(requiredEnvironment('THREADLOOP_SESSION_ID', { THREADLOOP_SESSION_ID: 'session_123' })).toBe('session_123');
  });

  it('rejects a missing required environment value with the variable name', () => {
    expect(() => requiredEnvironment('THREADLOOP_SESSION_ID', {})).toThrow('THREADLOOP_SESSION_ID is required.');
  });

  it('accepts only canonical safe positive decimal integers', () => {
    expect(positiveIntegerEnvironment('THREADLOOP_PULL_REQUEST_NUMBER', { THREADLOOP_PULL_REQUEST_NUMBER: '42' })).toBe(
      42,
    );
    expect(() =>
      positiveIntegerEnvironment('THREADLOOP_PULL_REQUEST_NUMBER', { THREADLOOP_PULL_REQUEST_NUMBER: '01' }),
    ).toThrow('THREADLOOP_PULL_REQUEST_NUMBER must be a positive decimal integer.');
    expect(() =>
      positiveIntegerEnvironment('THREADLOOP_PULL_REQUEST_NUMBER', {
        THREADLOOP_PULL_REQUEST_NUMBER: String(Number.MAX_SAFE_INTEGER + 1),
      }),
    ).toThrow('THREADLOOP_PULL_REQUEST_NUMBER must be a safe positive integer.');
  });

  it('admits a gate that declares setup, which both the run and sign steps depend on', () => {
    const context = gateSensorContext(gateEnvironment());
    expect(context.gate).toEqual(setupGate);
    expect(context.runInvocationUri).toBe('https://github.com/owner/repo/actions/runs/7/attempts/1');
  });

  it('rejects a gate whose id is not the declared gate id', () => {
    expect(() => gateSensorContext(gateEnvironment({ ...setupGate, id: 'other' }))).toThrow(
      'THREADLOOP_GATE_JSON must be the exact declared gate identified by THREADLOOP_GATE_ID.',
    );
  });
});
