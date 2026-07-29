import { describe, expect, it } from 'vitest';
import { positiveIntegerEnvironment, requiredEnvironment } from '../../scripts/sensor-environment.js';

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
});
