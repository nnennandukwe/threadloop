import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { AUDIT_EVENT_TYPES } from '../../src/domain/audit.js';
import { LIFECYCLE_DECISION_CODES } from '../../src/domain/lifecycle.js';
import { GATE_RECEIPT_RESULTS } from '../../src/domain/proof.js';
import { LIFECYCLE_PHASE, TASK_STATUS_VALUES } from '../../src/domain/types.js';

const mappingDocUrl = new URL('../../docs/current-lifecycle-graph-mapping.md', import.meta.url);

async function readMappingDoc(): Promise<string> {
  return readFile(mappingDocUrl, 'utf8');
}

function expectDocumentToContainAllCodeTokens(document: string, values: readonly string[], label: string): void {
  for (const value of values) {
    expect(document, `${label}: ${value}`).toMatch(new RegExp(`\`${escapeRegExp(value)}\``));
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('current lifecycle graph mapping documentation', () => {
  it('covers every exported lifecycle state, phase, and transition decision code', async () => {
    const document = await readMappingDoc();

    expectDocumentToContainAllCodeTokens(document, TASK_STATUS_VALUES, 'task status');
    expectDocumentToContainAllCodeTokens(document, Object.values(LIFECYCLE_PHASE), 'lifecycle phase');
    expectDocumentToContainAllCodeTokens(
      document,
      Object.values(LIFECYCLE_DECISION_CODES),
      'lifecycle transition code',
    );
  });

  it('covers proof receipts, review receipts, audit events, and public command families', async () => {
    const document = await readMappingDoc();

    expectDocumentToContainAllCodeTokens(document, GATE_RECEIPT_RESULTS, 'gate receipt result');
    expectDocumentToContainAllCodeTokens(
      document,
      ['policy_missing', 'missing', 'passed', 'current', 'failed', 'setup_failed', 'stale', 'corrupt'],
      'receipt status',
    );
    expectDocumentToContainAllCodeTokens(
      document,
      ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED', 'null'],
      'review decision',
    );
    expectDocumentToContainAllCodeTokens(document, AUDIT_EVENT_TYPES, 'audit event type');
    expectDocumentToContainAllCodeTokens(
      document,
      [
        'session start',
        'session list',
        'session status',
        'session capture',
        'session heartbeat',
        'session reconcile',
        'session next',
        'session transition',
        'session gate run',
        'session gate import',
        'session review import',
        'audit show',
        'audit verify',
        'audit export',
      ],
      'canonical session and audit command family',
    );
  });

  it('maps every required-work code', async () => {
    const document = await readMappingDoc();

    expectDocumentToContainAllCodeTokens(
      document,
      [
        'RESTORE_PROOF_AUTHORITY',
        'IMPLEMENT_ISSUE_40',
        'RESTORE_PROOF_BASELINE',
        'COMMIT_IMPLEMENTATION',
        'RECORD_PRE_PR_REVIEW_OUTCOME',
        'RESTORE_PROOF_CHECKOUT',
        'COMPLETE_CURRENT_PROOF',
        'RUN_MISSING_GATES',
        'RERUN_STALE_GATES',
        'RERUN_CORRUPT_GATES',
        'CORRECT_GATE_SETUP',
        'START_SESSION_WITH_CI_POLICY',
        'IMPORT_SIGNED_CI_PROOF',
        'RERUN_AND_IMPORT_CI_PROOF',
        'RESTORE_SIGNED_CI_PROOF',
        'RUN_CURRENT_GATES',
        'TRANSITION_TO_BLOCKED',
        'COMMIT_REPAIR',
        'START_SESSION_WITH_REVIEW_POLICY',
        'IMPORT_SIGNED_REVIEW_PROOF',
        'REFRESH_SIGNED_REVIEW_PROOF',
        'RESTORE_SIGNED_REVIEW_PROOF',
        'ENTER_REVIEW_REPAIR',
        'REFRESH_REVIEW_PROOF_SET',
        'OBTAIN_CURRENT_HUMAN_APPROVAL',
        'MERGE_AND_REFRESH_REVIEW_PROOF',
        'PROVIDE_BLOCK_EVIDENCE',
        'PROVIDE_RECOVERY_EVIDENCE',
        'RESTORE_BLOCKED_PRIOR_STATE',
      ],
      'required work',
    );
  });
});
