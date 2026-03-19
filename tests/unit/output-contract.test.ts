import { describe, expect, it } from 'vitest';
import { createCommandFailureEnvelope, createCommandSuccessEnvelope, renderCommandFailure, renderCommandSuccess } from '../../src/contracts/output.js';

describe('output contract', () => {
  it('renders a stable JSON success envelope', () => {
    expect(renderCommandSuccess('session start', {
      text: ['Started task: Example'],
      data: { session_id: 'session_123' },
    }, true)).toBe(
      JSON.stringify(createCommandSuccessEnvelope('session start', { session_id: 'session_123' }), null, 2),
    );
  });

  it('renders a stable JSON failure envelope', () => {
    expect(renderCommandFailure('session status', {
      code: 'SESSION_REQUIRED',
      message: 'A session id is required for this command.',
      details: { hint: 'Pass --session <id>.' },
    }, true)).toBe(
      JSON.stringify(
        createCommandFailureEnvelope('session status', {
          code: 'SESSION_REQUIRED',
          message: 'A session id is required for this command.',
          details: { hint: 'Pass --session <id>.' },
        }),
        null,
        2,
      ),
    );
  });

  it('renders stable text failures with public codes', () => {
    expect(renderCommandFailure('session capture', {
      code: 'SESSION_NOT_FOUND',
      message: 'Could not find active session: session_missing',
    }, false)).toBe('threadloop [SESSION_NOT_FOUND]: Could not find active session: session_missing');
  });
});
