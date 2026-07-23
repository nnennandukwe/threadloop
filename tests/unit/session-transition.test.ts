import { describe, expect, it, vi } from 'vitest';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import {
  canonicalizeTransitionRequest,
  evaluateTransitionGuards,
  planNextTransition,
  validateTransitionEvidence,
} from '../../src/domain/session-transition.js';

describe('session transition domain', () => {
  it('uses the injected digest for the canonical request bytes', () => {
    const digest = vi.fn(() => 'injected-sha256');
    const result = canonicalizeTransitionRequest(
      {
        sessionId: 'session_123',
        targetState: 'framed',
        expectedStateVersion: 0,
        actor: 'agent',
        input: {},
      },
      digest,
    );

    expect(digest).toHaveBeenCalledWith(result.requestJson);
    expect(result.requestSha256).toBe('injected-sha256');
  });

  it('canonicalizes recursively equivalent requests to the same bytes and digest', () => {
    const first = canonicalizeTransitionRequest(
      {
        sessionId: 'session_123',
        targetState: 'framed',
        expectedStateVersion: 0,
        actor: 'agent',
        input: { z: [{ b: 2, a: 1 }], a: true },
      },
      sha256,
    );
    const second = canonicalizeTransitionRequest(
      {
        actor: 'agent',
        expectedStateVersion: 0,
        input: { a: true, z: [{ a: 1, b: 2 }] },
        sessionId: 'session_123',
        targetState: 'framed',
      },
      sha256,
    );

    expect(first).toEqual(second);
    expect(first.requestJson).toBe(
      '{"actor":"agent","expected_state_version":0,"input":{"a":true,"z":[{"a":1,"b":2}]},"session_id":"session_123","target_state":"framed"}',
    );
    expect(first.requestSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('requires complete evidence before blocking or recovering', () => {
    expect(validateTransitionEvidence('queued', 'blocked', {})).toMatchObject({
      allowed: false,
      guardFailures: [{ code: 'BLOCK_EVIDENCE_REQUIRED' }],
    });
    expect(
      validateTransitionEvidence('queued', 'blocked', {
        block: {
          reason: 'Repository access is unavailable',
          evidence_ref: 'incident:123',
          recovery: 'Restore repository access',
          stop_code: 'REPO_UNAVAILABLE',
        },
      }),
    ).toMatchObject({ allowed: true });
    expect(validateTransitionEvidence('blocked', 'queued', { recovery: { approved_by: 'Nnenna' } })).toMatchObject({
      allowed: false,
      guardFailures: [{ code: 'RECOVERY_EVIDENCE_REQUIRED' }],
    });
  });

  it('fails deferred transitions closed under their downstream owner', () => {
    expect(evaluateTransitionGuards('framed', 'proof_ready', {}, null)).toEqual({
      allowed: false,
      guardFailures: [
        {
          code: 'PROOF_AUTHORITY_DEFERRED',
          message: 'Proof-plan and current-HEAD authority is not available in M002-2.',
          owner_issue: 40,
        },
      ],
      requiredWork: [
        {
          code: 'IMPLEMENT_ISSUE_40',
          description: 'Provide authoritative proof-plan, gate, staleness, and repair-budget evidence.',
          owner_issue: 40,
        },
      ],
    });
    expect(evaluateTransitionGuards('ready_for_human', 'completed', {}, null)).toMatchObject({
      allowed: false,
      guardFailures: [{ code: 'APPROVAL_AND_MERGE_EVIDENCE_DEFERRED', owner_issue: 42 }],
    });
  });

  it.each([
    ['queued', 'framed', true, null],
    ['framed', 'proof_ready', false, null],
    ['proof_ready', 'implementing', false, null],
    ['implementing', 'verifying', false, null],
    ['verifying', null, false, null],
    ['reviewing', null, false, null],
    ['repairing', 'verifying', false, null],
    ['ready_for_human', 'completed', false, null],
    ['blocked', 'implementing', false, 'BLOCKED_REQUIRES_HUMAN_RECOVERY'],
    ['completed', null, false, 'COMPLETED'],
  ] as const)('plans one deterministic candidate for %s', (state, targetState, executable, terminalReason) => {
    expect(
      planNextTransition({
        state,
        stateVersion: 7,
        blockedFromState: state === 'blocked' ? 'implementing' : null,
      }),
    ).toMatchObject({
      candidate:
        targetState === null
          ? null
          : {
              from_state: state,
              target_state: targetState,
              expected_state_version: 7,
              executable,
            },
      terminalReason,
    });
  });
});
