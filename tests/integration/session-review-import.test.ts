import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runGate, sessionNext, transition, transitionFailure } from '../helpers/cli.js';
import {
  cleanupTemporaryState,
  commitFiles,
  forceStates,
  git,
  makeCommittedRepo,
  makeTempDir,
  makeVerifyingSession,
  proofPlan,
  recordProofPlan,
  startFramedSession,
} from '../helpers/session.js';
import { countRows, deleteAuditLedger, readLifecycle, withStateDb, withTriggersDisabled } from '../helpers/state-db.js';
import {
  boundGateArtifact,
  boundReviewArtifact,
  fixtureRepository,
  signedGatePackage,
  signedReviewPackage,
  verifiedSigner,
  writeSignedPackage,
} from '../fixtures/receipts.js';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import { SigstoreReceiptVerificationError, type VerifiedSigstoreSigner } from '../../src/adapters/crypto/sigstore.js';
import { nodeSignedReceiptFileSystem } from '../../src/adapters/fs/signed-receipt-files.js';
import {
  applySessionTransition,
  closeSqliteConnections,
  EvidenceChangedError,
  readSessionEvidenceWatermarkReadOnly,
} from '../../src/adapters/fs/sqlite-store.js';
import { canonicalizeTransitionRequest, type TransitionRequest } from '../../src/domain/session-transition.js';
import type { SignedReviewReceiptArtifact } from '../../src/domain/review.js';
import {
  importSessionGateReceipt,
  importSessionReviewReceipt as importSessionReviewReceiptWithDependencies,
} from '../../src/services/session-service.js';

/** A gate that passes or fails on what the committed `gate-mode.txt` says, so repairs can flip it. */
const modeSwitchedGate = [
  'node',
  '-e',
  `const { readFileSync } = require('node:fs'); process.exit(readFileSync('gate-mode.txt', 'utf8').trim() === 'pass' ? 0 : 1);`,
];

type ReviewFixture = Awaited<ReturnType<typeof makeReviewingSession>>;

/** A session forced into `reviewing` at state version 6 without the evidence its guards would require. */
async function makeReviewingSession() {
  const fixture = await makeVerifyingSession();
  await forceStates(fixture.repoDir, fixture.sessionId, 4, ['pre_pr_reviewing', 'reviewing']);
  return { ...fixture, inputDir: await makeTempDir('threadloop-review-input-') };
}

/**
 * A session that reached `reviewing` at state version 6 through public transitions, with real local proof and
 * imported signed CI proof for its implementation commit, so later guards evaluate genuine evidence.
 */
async function makeAuthoritativeReviewingSession(gateCommand?: string[]): Promise<ReviewFixture> {
  const repoDir = await makeCommittedRepo();
  const sessionId = await startFramedSession(repoDir);
  const plan = proofPlan({ command: gateCommand });
  const recorded = await recordProofPlan(repoDir, sessionId, plan);
  await transition(repoDir, sessionId, 'implementing', 2, 'implementation:start');
  const fixture = {
    repoDir,
    sessionId,
    planSha256: recorded.data.proof_plan.sha256,
    gate: plan.gates[0]!,
    head: await commitFiles(repoDir, 'implement review fixture', {
      'implementation.txt': 'initial implementation\n',
      'gate-mode.txt': 'pass\n',
    }),
    inputDir: await makeTempDir('threadloop-review-input-'),
  };
  await transition(repoDir, sessionId, 'verifying', 3, 'implementation:verify');
  await runGate(repoDir, sessionId);
  await importCurrentSignedGate(fixture, 'receipt_signed_initial');
  await transition(repoDir, sessionId, 'pre_pr_reviewing', 4, 'implementation:pre-pr-review');
  await transition(repoDir, sessionId, 'reviewing', 5, 'implementation:review', {
    pre_pr_review: {
      outcome: 'clean',
      head_sha: fixture.head,
      evidence_ref: 'review-ledger:clean',
      evidence_sha256: 'a'.repeat(64),
      findings: [],
    },
  });
  return fixture;
}

async function importCurrentSignedGate(fixture: ReviewFixture, receiptId: string) {
  const artifact = boundGateArtifact(fixture, { receipt_id: receiptId });
  return importSessionGateReceipt({
    cwd: fixture.repoDir,
    sessionId: fixture.sessionId,
    packagePath: await writeSignedPackage(fixture.inputDir, signedGatePackage(artifact)),
    verifyReceipt: verifiedSigner('gate', artifact),
    receiptFileSystem: nodeSignedReceiptFileSystem,
  });
}

function writePackage(fixture: ReviewFixture, artifact: SignedReviewReceiptArtifact) {
  return writeSignedPackage(fixture.inputDir, signedReviewPackage(artifact));
}

function importPackage(
  fixture: ReviewFixture,
  packagePath: string,
  verifyReceipt: () => Promise<VerifiedSigstoreSigner>,
) {
  return importSessionReviewReceiptWithDependencies({
    cwd: fixture.repoDir,
    sessionId: fixture.sessionId,
    packagePath,
    verifyReceipt,
    receiptFileSystem: nodeSignedReceiptFileSystem,
  });
}

/** Writes `artifact`'s package and imports it as signed by the fixture review sensor. */
async function importReview(fixture: ReviewFixture, artifact = boundReviewArtifact(fixture)) {
  return importPackage(fixture, await writePackage(fixture, artifact), verifiedSigner('review', artifact));
}

function blockingReviewArtifact(fixture: ReviewFixture, receiptId: string, body: string) {
  return boundReviewArtifact(fixture, {
    receipt_id: receiptId,
    review: {
      decision: 'CHANGES_REQUESTED',
      approvals: [],
      threads: [
        {
          id: `thread-${receiptId}`,
          url: `${fixtureRepository}/pull/42#discussion_${receiptId}`,
          author_login: 'reviewer',
          author_type: 'User',
          body,
          path: 'src/review.ts',
          line: 10,
          resolved: false,
          outdated: false,
          created_at: '2026-07-26T11:00:00.000Z',
          updated_at: '2026-07-26T11:30:00.000Z',
        },
      ],
    },
  });
}

async function commitFixtureChanges(fixture: ReviewFixture, message: string, files: Record<string, string>) {
  fixture.head = await commitFiles(fixture.repoDir, message, files);
}

const reviewReceiptCount = (repoDir: string) => countRows(repoDir, 'signed_review_receipts');
const reviewImportAuditCount = (repoDir: string) =>
  countRows(repoDir, 'audit_events', `event_type = 'signed_review_receipt_imported'`);
const repairTransitionCount = (repoDir: string) => countRows(repoDir, 'session_transitions', `to_state = 'repairing'`);

afterEach(cleanupTemporaryState);

describe('signed review receipt import', () => {
  it('imports one verified current-HEAD package idempotently without advancing lifecycle state', async () => {
    const fixture = await makeReviewingSession();
    const artifact = boundReviewArtifact(fixture);
    const packagePath = await writePackage(fixture, artifact);

    const first = await importPackage(fixture, packagePath, verifiedSigner('review', artifact));
    const duplicate = await importPackage(fixture, packagePath, verifiedSigner('review', artifact));

    expect(first).toMatchObject({
      contract_version: 1,
      receipt: { id: 'review_signed_123', sequence: 1, pull_request_number: 42, subject_head_sha: fixture.head },
      already_imported: false,
      review: { status: 'current', decision: 'APPROVED', blocking_findings: [] },
      lifecycle: { state: 'reviewing', state_version: 6 },
    });
    expect(duplicate).toMatchObject({ receipt: { id: 'review_signed_123', sequence: 1 }, already_imported: true });
    expect(sha256(await readFile(path.join(fixture.repoDir, first.receipt.package.path)))).toBe(
      first.receipt.package.sha256,
    );

    closeSqliteConnections(fixture.repoDir);
    expect(reviewReceiptCount(fixture.repoDir)).toBe(1);
    expect(reviewImportAuditCount(fixture.repoDir)).toBe(1);
    expect(readLifecycle(fixture.repoDir)).toEqual({ status: 'reviewing', state_version: 6 });
  });

  it('maps a missing audit genesis before importing signed review evidence', async () => {
    const fixture = await makeReviewingSession();
    closeSqliteConnections(fixture.repoDir);
    deleteAuditLedger(fixture.repoDir, fixture.sessionId);

    await expect(
      importPackage(fixture, path.join(fixture.inputDir, 'unread-package.json'), () => {
        throw new Error('signature verification must not run');
      }),
    ).rejects.toMatchObject({
      code: 'AUDIT_VERIFICATION_FAILED',
      details: {
        session_id: fixture.sessionId,
        audit_error: { code: 'AUDIT_SEQUENCE_MISMATCH' },
        hint: 'Restore the ledger from trusted storage.',
      },
    });
    expect(reviewReceiptCount(fixture.repoDir)).toBe(0);
    expect(countRows(fixture.repoDir, 'audit_events')).toBe(0);
  });

  it('rejects task-projection drift before importing signed review evidence', async () => {
    const fixture = await makeReviewingSession();
    const artifact = boundReviewArtifact(fixture);
    const packagePath = await writePackage(fixture, artifact);
    closeSqliteConnections(fixture.repoDir);
    withStateDb(fixture.repoDir, (db) => db.prepare(`UPDATE tasks SET state_version = 7`).run(), { readOnly: false });
    const auditCount = countRows(fixture.repoDir, 'audit_events');

    await expect(importPackage(fixture, packagePath, verifiedSigner('review', artifact))).rejects.toMatchObject({
      code: 'STATE_CORRUPTED',
      details: {
        session_id: fixture.sessionId,
        hint: 'Restore transition history from trusted storage before retrying the receipt import.',
      },
    });
    expect(reviewReceiptCount(fixture.repoDir)).toBe(0);
    expect(countRows(fixture.repoDir, 'audit_events')).toBe(auditCount);
  });

  it('rejects a stale reviewed HEAD without persisting or promoting the package', async () => {
    const fixture = await makeReviewingSession();
    const artifact = boundReviewArtifact(fixture, {
      pull_request: { ...boundReviewArtifact(fixture).pull_request, head_sha: '9'.repeat(40) },
    });

    await expect(importReview(fixture, artifact)).rejects.toMatchObject({ code: 'SIGNED_RECEIPT_HEAD_MISMATCH' });
    expect(reviewReceiptCount(fixture.repoDir)).toBe(0);
  });

  it('rejects malformed and oversized packages before signature verification', async () => {
    const fixture = await makeReviewingSession();
    const malformedPath = path.join(fixture.inputDir, 'malformed.json');
    const oversizedPath = path.join(fixture.inputDir, 'oversized.json');
    await writeFile(malformedPath, '{not-json', 'utf8');
    await writeFile(oversizedPath, Buffer.alloc(10 * 1024 * 1024 + 1, 0x20));
    const mustNotVerify = () => {
      throw new Error('signature verification must not run');
    };

    await expect(importPackage(fixture, malformedPath, mustNotVerify)).rejects.toMatchObject({
      code: 'SIGNED_RECEIPT_INVALID',
    });
    await expect(importPackage(fixture, oversizedPath, mustNotVerify)).rejects.toMatchObject({
      code: 'SIGNED_RECEIPT_INVALID',
    });
    expect(reviewReceiptCount(fixture.repoDir)).toBe(0);
  });

  it.each([
    ['signature_invalid', 'SIGNED_RECEIPT_SIGNATURE_INVALID'],
    ['transparency_missing', 'SIGNED_RECEIPT_TRANSPARENCY_MISSING'],
  ] as const)('rejects %s verification failures without persistence', async (reason, code) => {
    const fixture = await makeReviewingSession();
    const packagePath = await writePackage(fixture, boundReviewArtifact(fixture));

    await expect(
      importPackage(fixture, packagePath, () =>
        Promise.reject(new SigstoreReceiptVerificationError(reason, `fixture ${reason}`)),
      ),
    ).rejects.toMatchObject({ code });
    expect(reviewReceiptCount(fixture.repoDir)).toBe(0);
  });

  it('rejects a verified signer projection that disagrees with the signed review artifact', async () => {
    const fixture = await makeReviewingSession();
    const artifact = boundReviewArtifact(fixture);
    const packagePath = await writePackage(fixture, artifact);

    await expect(
      importPackage(fixture, packagePath, async () => ({
        ...(await verifiedSigner('review', artifact)()),
        sourceRef: 'refs/heads/untrusted',
      })),
    ).rejects.toMatchObject({ code: 'SIGNED_RECEIPT_IDENTITY_MISMATCH' });
    expect(reviewReceiptCount(fixture.repoDir)).toBe(0);
  });

  it('rejects the same receipt id with different bytes and preserves the authoritative package', async () => {
    const fixture = await makeReviewingSession();
    const imported = await importReview(fixture);
    const authoritativeBytes = await readFile(path.join(fixture.repoDir, imported.receipt.package.path));

    await expect(
      importReview(fixture, boundReviewArtifact(fixture, { observed_at: '2026-07-26T12:05:00.000Z' })),
    ).rejects.toMatchObject({ code: 'SIGNED_RECEIPT_CONFLICT' });
    expect(reviewReceiptCount(fixture.repoDir)).toBe(1);
    expect(await readFile(path.join(fixture.repoDir, imported.receipt.package.path))).toEqual(authoritativeBytes);
  });

  it('rejects an older signed approval re-imported over a newer blocking review', async () => {
    const fixture = await makeAuthoritativeReviewingSession();
    await importReview(fixture, {
      ...blockingReviewArtifact(fixture, 'review_newer_blocker', 'Newer finding'),
      observed_at: '2026-07-26T12:05:00.000Z',
    });

    const replay = (await importReview(
      fixture,
      boundReviewArtifact(fixture, { receipt_id: 'review_older_approval', observed_at: '2026-07-26T12:00:00.000Z' }),
    ).catch((error: unknown) => error)) as Error;
    expect(replay).toMatchObject({ code: 'SIGNED_RECEIPT_CONFLICT' });
    expect(replay.message).toContain('was observed before already-imported review receipt review_newer_blocker');
    expect(reviewReceiptCount(fixture.repoDir)).toBe(1);
    expect(
      (await transitionFailure(fixture.repoDir, fixture.sessionId, 'ready_for_human', 6, 'review:after-replay')).error
        .code,
    ).toBe('TRANSITION_GUARD_FAILED');
  });

  it('rejects review evidence for a different pull request than the session already imported', async () => {
    const fixture = await makeAuthoritativeReviewingSession();
    const first = boundReviewArtifact(fixture, { receipt_id: 'review_pr_42' });
    await importReview(fixture, first);

    const mismatch = (await importReview(
      fixture,
      boundReviewArtifact(fixture, {
        receipt_id: 'review_pr_43',
        observed_at: '2026-07-26T12:05:00.000Z',
        pull_request: { ...first.pull_request, number: 43, url: `${fixtureRepository}/pull/43` },
      }),
    ).catch((error: unknown) => error)) as Error;
    expect(mismatch).toMatchObject({ code: 'SIGNED_RECEIPT_CONFLICT' });
    expect(mismatch.message).toContain('describes #43');
    expect(reviewReceiptCount(fixture.repoDir)).toBe(1);
  });

  it('reports unreadable stored review evidence as state corruption instead of a bad argument', async () => {
    const fixture = await makeAuthoritativeReviewingSession();
    await importReview(fixture, boundReviewArtifact(fixture, { receipt_id: 'review_before_corruption' }));
    withStateDb(
      fixture.repoDir,
      (db) =>
        withTriggersDisabled(db, 'signed_review_receipts', () =>
          db.prepare(`UPDATE signed_review_receipts SET artifact_json = 'null'`).run(),
        ),
      { readOnly: false },
    );

    await expect(
      importReview(
        fixture,
        boundReviewArtifact(fixture, {
          receipt_id: 'review_after_corruption',
          observed_at: '2026-07-26T12:05:00.000Z',
        }),
      ),
    ).rejects.toMatchObject({ code: 'STATE_CORRUPTED', details: { receipt_id: 'review_before_corruption' } });
    expect(reviewReceiptCount(fixture.repoDir)).toBe(1);
  });

  it('refuses to apply a transition whose guard evidence changed after evaluation, without burning the key', async () => {
    const fixture = await makeAuthoritativeReviewingSession();
    await importReview(fixture, boundReviewArtifact(fixture, { receipt_id: 'review_clean_before_race' }));
    // The guard context a concurrent transition evaluated against: clean review, no blockers.
    const evaluatedWatermark = readSessionEvidenceWatermarkReadOnly(fixture.repoDir, fixture.sessionId);
    await importReview(fixture, {
      ...blockingReviewArtifact(fixture, 'review_blocker_during_race', 'Arrived mid-transition'),
      observed_at: '2026-07-26T12:05:00.000Z',
    });
    const request: TransitionRequest = {
      sessionId: fixture.sessionId,
      targetState: 'ready_for_human',
      expectedStateVersion: 6,
      actor: 'agent',
      input: {},
    };

    await expect(
      applySessionTransition(
        fixture.repoDir,
        {
          ...request,
          idempotencyKey: 'review:raced',
          evidenceWatermark: evaluatedWatermark,
          ...canonicalizeTransitionRequest(request, sha256),
        },
        () => ({ allowed: true, guardFailures: [], requiredWork: [] }),
      ),
    ).rejects.toBeInstanceOf(EvidenceChangedError);
    expect(readLifecycle(fixture.repoDir)).toEqual({ status: 'reviewing', state_version: 6 });

    // The same key is still unused, so a retry is evaluated against the blocker instead of replaying a result.
    expect(
      (await transitionFailure(fixture.repoDir, fixture.sessionId, 'ready_for_human', 6, 'review:raced')).error.code,
    ).toBe('TRANSITION_GUARD_FAILED');
  });

  it('serializes concurrent identical imports into one receipt and one audit event', async () => {
    const fixture = await makeReviewingSession();
    const artifact = boundReviewArtifact(fixture);
    const packagePath = await writePackage(fixture, artifact);

    const results = await Promise.all([
      importPackage(fixture, packagePath, verifiedSigner('review', artifact)),
      importPackage(fixture, packagePath, verifiedSigner('review', artifact)),
    ]);

    expect(results.map((result) => result.already_imported).sort()).toEqual([false, true]);
    expect(reviewReceiptCount(fixture.repoDir)).toBe(1);
    expect(reviewImportAuditCount(fixture.repoDir)).toBe(1);
  });

  it('removes a newly promoted final package when the enclosing transaction fails', async () => {
    const fixture = await makeReviewingSession();
    const artifact = boundReviewArtifact(fixture);
    const packagePath = await writePackage(fixture, artifact);
    const finalPackagePath = path.join(
      fixture.repoDir,
      '.threadloop/artifacts/receipts',
      fixture.sessionId,
      artifact.receipt_id,
      'signed-review-receipt.json',
    );
    let failStagedUnlink = true;

    await expect(
      importSessionReviewReceiptWithDependencies({
        cwd: fixture.repoDir,
        sessionId: fixture.sessionId,
        packagePath,
        verifyReceipt: verifiedSigner('review', artifact),
        receiptFileSystem: {
          ...nodeSignedReceiptFileSystem,
          unlink(filePath) {
            if (failStagedUnlink && filePath.includes('.signed-review-receipt.')) {
              failStagedUnlink = false;
              throw new Error('simulated transaction failure after promotion');
            }
            nodeSignedReceiptFileSystem.unlink(filePath);
          },
        },
      }),
    ).rejects.toThrow('simulated transaction failure after promotion');
    expect(reviewReceiptCount(fixture.repoDir)).toBe(0);
    expect(reviewImportAuditCount(fixture.repoDir)).toBe(0);
    expect(existsSync(finalPackagePath)).toBe(false);
  });

  it('projects a corrupted controlled review package as corrupt and blocks progression safely', async () => {
    const fixture = await makeAuthoritativeReviewingSession();
    const imported = await importReview(
      fixture,
      boundReviewArtifact(fixture, { receipt_id: 'review_corrupt_after_import' }),
    );
    await writeFile(
      path.join(fixture.repoDir, imported.receipt.package.path),
      Buffer.alloc(10 * 1024 * 1024 + 1, 0x20),
    );

    expect(await sessionNext(fixture.repoDir, fixture.sessionId)).toMatchObject({
      lifecycle: { state: 'reviewing', state_version: 6 },
      candidate: { target_state: 'ready_for_human', executable: false },
      review: { status: 'corrupt' },
      required_work: [{ code: 'RESTORE_SIGNED_REVIEW_PROOF' }],
    });
    expect(
      await transitionFailure(fixture.repoDir, fixture.sessionId, 'ready_for_human', 6, 'review:corrupt-package'),
    ).toMatchObject({
      error: {
        code: 'TRANSITION_GUARD_FAILED',
        details: { guard_failures: [{ code: 'UNCORRUPTED_REVIEW_PROOF_REQUIRED' }] },
      },
    });
    expect(readLifecycle(fixture.repoDir)).toEqual({ status: 'reviewing', state_version: 6 });
  });

  it('forbids implementation re-entry after the pre-PR phase closes', async () => {
    const fixture = await makeReviewingSession();

    expect(
      await transitionFailure(fixture.repoDir, fixture.sessionId, 'implementing', 6, 'post-pr:implementation-reentry'),
    ).toMatchObject({
      error: {
        code: 'TRANSITION_NOT_ALLOWED',
        details: {
          actual_state_version: 6,
          lifecycle_phase: 'post_pr',
          decision_code: 'POST_PR_IMPLEMENTATION_REENTRY_FORBIDDEN',
          unchanged: ['lifecycle', 'repair_budget', 'proof', 'review_evidence'],
        },
      },
    });
    expect(readLifecycle(fixture.repoDir)).toEqual({ status: 'reviewing', state_version: 6 });
    expect(repairTransitionCount(fixture.repoDir)).toBe(0);
  });

  it('routes a later current-HEAD blocking finding from human authority back to repair', async () => {
    const fixture = await makeAuthoritativeReviewingSession();
    await importReview(fixture, boundReviewArtifact(fixture, { receipt_id: 'review_clean_before_late_finding' }));
    await transition(fixture.repoDir, fixture.sessionId, 'ready_for_human', 6, 'review:ready');
    await importReview(
      fixture,
      blockingReviewArtifact(fixture, 'review_late_blocker', 'A late current-HEAD finding must reopen bounded repair'),
    );

    expect(await sessionNext(fixture.repoDir, fixture.sessionId)).toMatchObject({
      candidate: { target_state: 'repairing', executable: true },
      review: { status: 'current', blocking_findings: [{ id: 'thread-review_late_blocker' }] },
    });
    await transition(fixture.repoDir, fixture.sessionId, 'repairing', 7, 'review:late-repair');
    expect(readLifecycle(fixture.repoDir)).toEqual({ status: 'repairing', state_version: 8 });
  });

  it('rejects a wrong-HEAD approval, then completes through public transitions after current approval and merge evidence', async () => {
    const fixture = await makeAuthoritativeReviewingSession();
    const current = boundReviewArtifact(fixture);
    await importReview(
      fixture,
      boundReviewArtifact(fixture, {
        receipt_id: 'review_merged_wrong_head',
        pull_request: { ...current.pull_request, merged: true, merged_at: '2026-07-26T12:00:00.000Z' },
        review: {
          decision: 'APPROVED',
          approvals: [{ ...current.review.approvals[0]!, commit_sha: '9'.repeat(40) }],
          threads: [],
        },
      }),
    );
    await transition(fixture.repoDir, fixture.sessionId, 'ready_for_human', 6, 'review:human-authority');

    expect(
      await transitionFailure(fixture.repoDir, fixture.sessionId, 'completed', 7, 'review:wrong-head-completion'),
    ).toMatchObject({
      error: {
        code: 'TRANSITION_GUARD_FAILED',
        details: { guard_failures: [{ code: 'CURRENT_HUMAN_APPROVAL_REQUIRED' }] },
      },
    });
    expect(readLifecycle(fixture.repoDir)).toEqual({ status: 'ready_for_human', state_version: 7 });

    await importReview(
      fixture,
      boundReviewArtifact(fixture, {
        receipt_id: 'review_merged_current_head',
        pull_request: { ...current.pull_request, merged: true, merged_at: '2026-07-26T12:05:00.000Z' },
        observed_at: '2026-07-26T12:06:00.000Z',
      }),
    );

    const completed = await transition(
      fixture.repoDir,
      fixture.sessionId,
      'completed',
      7,
      'review:approved-merged-completion',
    );
    expect(completed.data).toMatchObject({ lifecycle: { state: 'completed', state_version: 8 } });
    expect(completed.data.session.ended_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(readLifecycle(fixture.repoDir)).toEqual({ status: 'completed', state_version: 8 });
  });

  it('counts persisted review and gate repair entries together and rejects a fourth review repair', async () => {
    const fixture = await makeAuthoritativeReviewingSession(modeSwitchedGate);
    const { repoDir, sessionId } = fixture;
    await importReview(fixture, blockingReviewArtifact(fixture, 'review_budget_first', 'Open the review repair cycle'));
    await transition(repoDir, sessionId, 'repairing', 6, 'budget:review-repair');

    await commitFixtureChanges(fixture, 'repair review finding', {
      'gate-mode.txt': 'fail\n',
      'repairs.txt': 'review repair\n',
    });
    await transition(repoDir, sessionId, 'verifying', 7, 'budget:first-verify');
    await runGate(repoDir, sessionId);
    await transition(repoDir, sessionId, 'repairing', 8, 'budget:first-gate-repair');

    await commitFixtureChanges(fixture, 'repair first gate failure', { 'repairs.txt': 'first gate repair\n' });
    await transition(repoDir, sessionId, 'verifying', 9, 'budget:second-verify');
    await runGate(repoDir, sessionId);
    await transition(repoDir, sessionId, 'repairing', 10, 'budget:second-gate-repair');

    await commitFixtureChanges(fixture, 'repair second gate failure', {
      'gate-mode.txt': 'pass\n',
      'repairs.txt': 'second gate repair\n',
    });
    await transition(repoDir, sessionId, 'verifying', 11, 'budget:third-verify');
    await runGate(repoDir, sessionId);
    await importCurrentSignedGate(fixture, 'receipt_signed_after_three_repairs');
    await transition(repoDir, sessionId, 'reviewing', 12, 'budget:return-to-review');

    await importReview(
      fixture,
      blockingReviewArtifact(fixture, 'review_budget_fourth', 'A fourth repair must be rejected'),
    );

    expect(await transitionFailure(repoDir, sessionId, 'repairing', 13, 'budget:fourth-review-repair')).toMatchObject({
      error: {
        code: 'TRANSITION_GUARD_FAILED',
        details: { guard_failures: [{ code: 'REPAIR_BUDGET_EXHAUSTED' }] },
      },
    });
    expect(readLifecycle(repoDir)).toEqual({ status: 'reviewing', state_version: 13 });
    expect(repairTransitionCount(repoDir)).toBe(3);
  });

  it('keeps the review snapshot that opened a repair as its basis even if that evidence later reads as corrupt', async () => {
    const fixture = await makeAuthoritativeReviewingSession();
    const imported = await importReview(
      fixture,
      blockingReviewArtifact(fixture, 'review_opens_repair', 'Fix before readiness'),
    );
    await transition(fixture.repoDir, fixture.sessionId, 'repairing', 6, 'review-basis:open');
    await commitFixtureChanges(fixture, 'repair the review finding', { 'repair.txt': 'review repair\n' });
    await writeFile(
      path.join(fixture.repoDir, imported.receipt.package.path),
      Buffer.alloc(10 * 1024 * 1024 + 1, 0x20),
    );

    await transition(fixture.repoDir, fixture.sessionId, 'verifying', 7, 'review-basis:verify');
    expect(readLifecycle(fixture.repoDir)).toEqual({ status: 'verifying', state_version: 8 });
  });

  it('requires a descendant commit after the exact evidence that opened each repair cycle', async () => {
    const fixture = await makeAuthoritativeReviewingSession(modeSwitchedGate);
    const { repoDir, sessionId, head: reviewHead } = fixture;
    await importReview(fixture, blockingReviewArtifact(fixture, 'review_cycle', 'Open the first repair cycle'));
    await transition(repoDir, sessionId, 'repairing', 6, 'review-cycle:open');

    const gateFailureHead = await commitFiles(repoDir, 'repair review finding', {
      'repair.txt': 'review repair\n',
      'gate-mode.txt': 'fail\n',
    });
    await transition(repoDir, sessionId, 'verifying', 7, 'review-cycle:verify');
    expect(gateFailureHead).not.toBe(reviewHead);
    await runGate(repoDir, sessionId);
    await transition(repoDir, sessionId, 'repairing', 8, 'gate-cycle:open');

    const committedRepairRequired = {
      error: {
        code: 'TRANSITION_GUARD_FAILED',
        details: { guard_failures: [{ code: 'COMMITTED_REPAIR_REQUIRED' }] },
      },
    };
    expect(await transitionFailure(repoDir, sessionId, 'verifying', 9, 'gate-cycle:no-repair')).toMatchObject(
      committedRepairRequired,
    );

    await commitFiles(repoDir, 'repair newer gate failure', { 'repair.txt': 'gate repair\n' });
    await git(repoDir, 'reset', '--hard', reviewHead);
    expect(await transitionFailure(repoDir, sessionId, 'verifying', 9, 'gate-cycle:ancestor-rollback')).toMatchObject(
      committedRepairRequired,
    );
  });
});
