import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { parseJson, runCli } from '../helpers/cli.js';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import { SigstoreReceiptVerificationError, type VerifiedSigstoreSigner } from '../../src/adapters/crypto/sigstore.js';
import { DatabaseSync } from '../../src/adapters/fs/sqlite-driver.js';
import { nodeSignedReceiptFileSystem } from '../../src/adapters/fs/signed-receipt-files.js';
import { applySessionTransition, resetSqliteConnections } from '../../src/adapters/fs/sqlite-store.js';
import {
  buildInTotoReceiptStatement,
  canonicalizeSignedGateReceiptArtifact,
  IN_TOTO_PAYLOAD_TYPE,
  SIGNED_RECEIPT_MEDIA_TYPE_V2,
  type SignedGateReceiptArtifact,
} from '../../src/domain/attestation.js';
import { canonicalJson } from '../../src/domain/canonical-json.js';
import { canonicalizeTransitionRequest, type TransitionRequest } from '../../src/domain/session-transition.js';
import {
  buildInTotoReviewStatement,
  canonicalizeSignedReviewReceiptArtifact,
  REVIEW_IN_TOTO_PAYLOAD_TYPE,
  SIGNED_REVIEW_RECEIPT_MEDIA_TYPE,
  type SignedReviewReceiptArtifact,
} from '../../src/domain/review.js';
import {
  importSessionGateReceipt as importSessionGateReceiptWithDependencies,
  importSessionReviewReceipt as importSessionReviewReceiptWithDependencies,
  type ImportSessionGateReceiptInput,
  type ImportSessionReviewReceiptInput,
} from '../../src/services/session-service.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const branch = 'issue-42/review-audit-handoff';
const sourceRepository = 'https://github.com/example/project';
const workflowHead = 'd'.repeat(40);
const gateSignerSha = 'e'.repeat(40);
const reviewSignerSha = 'f'.repeat(40);
const certificateIdentity = `${sourceRepository}/.github/workflows/threadloop.yml@refs/heads/${branch}`;
const gateSignerUri = `https://github.com/nnennandukwe/threadloop/.github/workflows/threadloop-gate-sensor.yml@${gateSignerSha}`;
const reviewSignerUri = `https://github.com/nnennandukwe/threadloop/.github/workflows/threadloop-review-sensor.yml@${reviewSignerSha}`;

function importSessionReviewReceipt(input: Omit<ImportSessionReviewReceiptInput, 'receiptFileSystem'>) {
  return importSessionReviewReceiptWithDependencies({
    ...input,
    receiptFileSystem: nodeSignedReceiptFileSystem,
  });
}

function importSessionGateReceipt(input: Omit<ImportSessionGateReceiptInput, 'receiptFileSystem'>) {
  return importSessionGateReceiptWithDependencies({
    ...input,
    receiptFileSystem: nodeSignedReceiptFileSystem,
  });
}

async function makeReviewingSession(
  gateCommand = ['node', '-e', 'process.exit(0)'],
  options: { directReviewState?: boolean } = {},
) {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), 'threadloop-review-import-'));
  const inputDir = await mkdtemp(path.join(os.tmpdir(), 'threadloop-review-input-'));
  temporaryDirectories.push(repoDir, inputDir);
  await execFileAsync('git', ['init'], { cwd: repoDir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
  await execFileAsync('git', ['remote', 'add', 'origin', `${sourceRepository}.git`], { cwd: repoDir });
  await writeFile(path.join(repoDir, 'README.md'), '# review receipt fixture\n', 'utf8');
  await execFileAsync('git', ['add', 'README.md'], { cwd: repoDir });
  await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: repoDir });
  await execFileAsync('git', ['branch', '-M', branch], { cwd: repoDir });

  const started = parseJson<{ data: { session_id: string } }>(
    (
      await runCli(repoDir, [
        'session',
        'start',
        'Signed review task',
        '--goal',
        'Require authoritative review evidence',
        '--issue',
        '#42',
        '--json',
      ])
    ).stdout,
  );
  await execFileAsync('git', ['add', '.threadloop/config.json'], { cwd: repoDir });
  await execFileAsync('git', ['commit', '-m', 'initialize ThreadLoop'], { cwd: repoDir });
  await runCli(repoDir, [
    'session',
    'transition',
    'framed',
    '--session',
    started.data.session_id,
    '--expected-state-version',
    '0',
    '--idempotency-key',
    'frame:review',
    '--actor',
    'agent',
    '--input',
    '{}',
    '--json',
  ]);
  const proofPlan = {
    contract_version: 4,
    acceptance_criteria: ['All proof and review requirements pass'],
    ci: trustPolicy(gateSignerUri, gateSignerSha),
    review: trustPolicy(reviewSignerUri, reviewSignerSha),
    gates: [
      {
        id: 'check',
        command: gateCommand,
        working_directory: '.',
        timeout_ms: 5_000,
      },
    ],
  };
  const proofReady = parseJson<{ data: { proof_plan: { sha256: string } } }>(
    (
      await runCli(repoDir, [
        'session',
        'transition',
        'proof_ready',
        '--session',
        started.data.session_id,
        '--expected-state-version',
        '1',
        '--idempotency-key',
        'proof:review',
        '--actor',
        'agent',
        '--input',
        JSON.stringify({ proof_plan: proofPlan }),
        '--json',
      ])
    ).stdout,
  );

  if (options.directReviewState ?? true) {
    for (const [targetState, expectedStateVersion] of [
      ['implementing', 2],
      ['verifying', 3],
      ['pre_pr_reviewing', 4],
      ['reviewing', 5],
    ] as const) {
      const request: TransitionRequest = {
        sessionId: started.data.session_id,
        targetState,
        expectedStateVersion,
        actor: 'agent',
        input: {},
      };
      const result = await applySessionTransition(
        repoDir,
        {
          ...request,
          idempotencyKey: `fixture:${targetState}`,
          ...canonicalizeTransitionRequest(request, sha256),
        },
        () => ({ allowed: true, guardFailures: [], requiredWork: [] }),
      );
      if (!result.ok) {
        throw new Error(`Could not prepare reviewing fixture: ${result.error.code}`);
      }
    }
  }
  const head = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoDir })).stdout.trim();
  return {
    repoDir,
    inputDir,
    sessionId: started.data.session_id,
    planSha256: proofReady.data.proof_plan.sha256,
    head,
    gate: proofPlan.gates[0]!,
  };
}

function trustPolicy(buildSignerUri: string, buildSignerSha: string) {
  return {
    provider: 'github-actions' as const,
    issuer: 'https://token.actions.githubusercontent.com' as const,
    certificate_identity: certificateIdentity,
    source_repository: sourceRepository,
    build_signer_uri: buildSignerUri,
    build_signer_sha: buildSignerSha,
  };
}

function reviewArtifact(
  fixture: Awaited<ReturnType<typeof makeReviewingSession>>,
  overrides: Partial<SignedReviewReceiptArtifact> = {},
): SignedReviewReceiptArtifact {
  return {
    schema_version: 1,
    receipt_id: 'review_signed_123',
    session_id: fixture.sessionId,
    plan_sha256: fixture.planSha256,
    pull_request: {
      number: 42,
      url: `${sourceRepository}/pull/42`,
      head_sha: fixture.head,
      base_ref: 'main',
      merged: false,
      merged_at: null,
    },
    review: {
      decision: 'APPROVED',
      approvals: [
        {
          actor_id: 'user-1',
          actor_login: 'reviewer',
          actor_type: 'User',
          state: 'APPROVED',
          commit_sha: fixture.head,
          submitted_at: '2026-07-26T11:00:00.000Z',
        },
      ],
      threads: [],
    },
    observed_at: '2026-07-26T12:00:00.000Z',
    source: {
      repository: sourceRepository,
      ref: `refs/heads/${branch}`,
      head_sha: workflowHead,
      run_invocation_uri: `${sourceRepository}/actions/runs/123/attempts/1`,
    },
    sensor: { name: 'threadloop-github-actions-review', contract_version: 1 },
    ...overrides,
  };
}

async function writePackage(
  fixture: Awaited<ReturnType<typeof makeReviewingSession>>,
  artifact: SignedReviewReceiptArtifact,
) {
  const canonical = canonicalizeSignedReviewReceiptArtifact(artifact, sha256);
  const statement = buildInTotoReviewStatement(canonical.artifact, canonical.sha256);
  const packagePath = path.join(fixture.inputDir, `${artifact.receipt_id}.json`);
  await writeFile(
    packagePath,
    canonicalJson({
      media_type: SIGNED_REVIEW_RECEIPT_MEDIA_TYPE,
      artifact,
      bundle: {
        mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
        dsseEnvelope: {
          payload: Buffer.from(canonicalJson(statement)).toString('base64'),
          payloadType: REVIEW_IN_TOTO_PAYLOAD_TYPE,
          signatures: [{ keyid: '', sig: 'c2lnbmF0dXJl' }],
        },
        verificationMaterial: {
          certificate: { rawBytes: 'Y2VydGlmaWNhdGU=' },
          tlogEntries: [
            {
              inclusionProof: {
                checkpoint: { envelope: 'checkpoint' },
                logIndex: '1',
                rootHash: 'cm9vdA==',
                treeSize: '2',
                hashes: [],
              },
            },
          ],
        },
      },
    }),
    'utf8',
  );
  return packagePath;
}

function verifier(artifact: SignedReviewReceiptArtifact): Promise<VerifiedSigstoreSigner> {
  return Promise.resolve({
    issuer: 'https://token.actions.githubusercontent.com',
    certificateIdentity,
    buildSignerUri: reviewSignerUri,
    buildSignerSha: reviewSignerSha,
    sourceRepository,
    sourceHeadSha: artifact.source.head_sha,
    sourceRef: artifact.source.ref,
    runnerEnvironment: 'github-hosted',
    runInvocationUri: artifact.source.run_invocation_uri,
  });
}

type ReviewFixture = Awaited<ReturnType<typeof makeReviewingSession>>;

function signedGateArtifact(fixture: ReviewFixture, receiptId: string): SignedGateReceiptArtifact {
  return {
    schema_version: 2,
    receipt_id: receiptId,
    session_id: fixture.sessionId,
    plan_sha256: fixture.planSha256,
    gate: fixture.gate,
    result: 'passed',
    setup: [],
    started_at: '2026-07-26T10:00:00.000Z',
    ended_at: '2026-07-26T10:00:01.000Z',
    duration_ms: 1_000,
    exit_status: 0,
    signal: null,
    head_before: fixture.head,
    head_after: fixture.head,
    clean_before: true,
    clean_after: true,
    output: { stdout_sha256: '1'.repeat(64), stderr_sha256: '2'.repeat(64) },
    source: {
      repository: sourceRepository,
      ref: `refs/heads/${branch}`,
      head_sha: fixture.head,
      run_invocation_uri: `${sourceRepository}/actions/runs/456/attempts/1`,
    },
    environment: {
      runner_environment: 'github-hosted',
      runner_os: 'Linux',
      runner_arch: 'X64',
      node_version: 'v22.13.0',
    },
    sensor: { name: 'threadloop-github-actions-gate', contract_version: 2 },
  };
}

async function writeGatePackage(fixture: ReviewFixture, artifact: SignedGateReceiptArtifact) {
  const canonical = canonicalizeSignedGateReceiptArtifact(artifact, sha256);
  const statement = buildInTotoReceiptStatement(canonical.artifact, canonical.sha256);
  const packagePath = path.join(fixture.inputDir, `${artifact.receipt_id}.json`);
  await writeFile(
    packagePath,
    canonicalJson({
      media_type: SIGNED_RECEIPT_MEDIA_TYPE_V2,
      artifact,
      bundle: {
        mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
        dsseEnvelope: {
          payload: Buffer.from(canonicalJson(statement)).toString('base64'),
          payloadType: IN_TOTO_PAYLOAD_TYPE,
          signatures: [{ keyid: '', sig: 'c2lnbmF0dXJl' }],
        },
        verificationMaterial: {
          certificate: { rawBytes: 'Y2VydGlmaWNhdGU=' },
          tlogEntries: [
            {
              inclusionProof: {
                checkpoint: { envelope: 'checkpoint' },
                logIndex: '1',
                rootHash: 'cm9vdA==',
                treeSize: '2',
                hashes: [],
              },
            },
          ],
        },
      },
    }),
    'utf8',
  );
  return packagePath;
}

function gateVerifier(artifact: SignedGateReceiptArtifact): Promise<VerifiedSigstoreSigner> {
  return Promise.resolve({
    issuer: 'https://token.actions.githubusercontent.com',
    certificateIdentity,
    buildSignerUri: gateSignerUri,
    buildSignerSha: gateSignerSha,
    sourceRepository,
    sourceHeadSha: artifact.source.head_sha,
    sourceRef: artifact.source.ref,
    runnerEnvironment: 'github-hosted',
    runInvocationUri: artifact.source.run_invocation_uri,
  });
}

async function importCurrentSignedGate(fixture: ReviewFixture, receiptId: string) {
  const artifact = signedGateArtifact(fixture, receiptId);
  const packagePath = await writeGatePackage(fixture, artifact);
  return importSessionGateReceipt({
    cwd: fixture.repoDir,
    sessionId: fixture.sessionId,
    packagePath,
    verifyReceipt: () => gateVerifier(artifact),
  });
}

async function makeAuthoritativeReviewingSession(
  gateCommand: string[] = ['node', '-e', 'process.exit(0)'],
): Promise<ReviewFixture> {
  const fixture = await makeReviewingSession(gateCommand, { directReviewState: false });
  await transitionSession(fixture.repoDir, fixture.sessionId, 'implementing', 2, 'implementation:start');
  await writeFile(path.join(fixture.repoDir, 'implementation.txt'), 'initial implementation\n', 'utf8');
  await writeFile(path.join(fixture.repoDir, 'gate-mode.txt'), 'pass\n', 'utf8');
  await execFileAsync('git', ['add', 'implementation.txt', 'gate-mode.txt'], { cwd: fixture.repoDir });
  await execFileAsync('git', ['commit', '-m', 'implement review fixture'], { cwd: fixture.repoDir });
  fixture.head = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: fixture.repoDir })).stdout.trim();
  await transitionSession(fixture.repoDir, fixture.sessionId, 'verifying', 3, 'implementation:verify');
  await runCli(fixture.repoDir, ['session', 'gate', 'run', 'check', '--session', fixture.sessionId, '--json']);
  await importCurrentSignedGate(fixture, 'receipt_signed_initial');
  await transitionSession(fixture.repoDir, fixture.sessionId, 'pre_pr_reviewing', 4, 'implementation:pre-pr-review');
  await transitionSession(fixture.repoDir, fixture.sessionId, 'reviewing', 5, 'implementation:review', {
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

function blockingReviewArtifact(fixture: ReviewFixture, receiptId: string, body: string) {
  return reviewArtifact(fixture, {
    receipt_id: receiptId,
    review: {
      decision: 'CHANGES_REQUESTED',
      approvals: [],
      threads: [
        {
          id: `thread-${receiptId}`,
          url: `${sourceRepository}/pull/42#discussion_${receiptId}`,
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

afterEach(async () => {
  await resetSqliteConnections();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('signed review receipt import', () => {
  it('imports one verified current-HEAD package idempotently without advancing lifecycle state', async () => {
    const fixture = await makeReviewingSession();
    const artifact = reviewArtifact(fixture);
    const packagePath = await writePackage(fixture, artifact);

    const first = await importSessionReviewReceipt({
      cwd: fixture.repoDir,
      sessionId: fixture.sessionId,
      packagePath,
      verifyReceipt: () => verifier(artifact),
    });
    const duplicate = await importSessionReviewReceipt({
      cwd: fixture.repoDir,
      sessionId: fixture.sessionId,
      packagePath,
      verifyReceipt: () => verifier(artifact),
    });

    expect(first).toMatchObject({
      contract_version: 1,
      receipt: {
        id: 'review_signed_123',
        sequence: 1,
        pull_request_number: 42,
        subject_head_sha: fixture.head,
      },
      already_imported: false,
      review: {
        status: 'current',
        decision: 'APPROVED',
        blocking_findings: [],
      },
      lifecycle: { state: 'reviewing', state_version: 6 },
    });
    expect(duplicate).toMatchObject({
      receipt: { id: 'review_signed_123', sequence: 1 },
      already_imported: true,
    });
    expect(sha256(await readFile(path.join(fixture.repoDir, first.receipt.package.path)))).toBe(
      first.receipt.package.sha256,
    );

    await resetSqliteConnections(fixture.repoDir);
    const db = new DatabaseSync(path.join(fixture.repoDir, '.threadloop/state/state.db'), { readOnly: true });
    try {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM signed_review_receipts`).get()).toEqual({ count: 1 });
      expect(
        db
          .prepare(`SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'signed_review_receipt_imported'`)
          .get(),
      ).toEqual({ count: 1 });
      expect(db.prepare(`SELECT status, state_version FROM tasks`).get()).toEqual({
        status: 'reviewing',
        state_version: 6,
      });
    } finally {
      db.close();
    }
  });

  it('maps a missing audit genesis before importing signed review evidence', async () => {
    const fixture = await makeReviewingSession();
    await resetSqliteConnections(fixture.repoDir);
    const dbPath = path.join(fixture.repoDir, '.threadloop/state/state.db');
    const corrupt = new DatabaseSync(dbPath);
    corrupt.exec(`
      DROP TRIGGER audit_events_no_delete;
      DELETE FROM audit_events WHERE session_id = '${fixture.sessionId}';
      CREATE TRIGGER audit_events_no_delete
      BEFORE DELETE ON audit_events
      BEGIN
        SELECT RAISE(ABORT, 'audit events are immutable');
      END;
    `);
    corrupt.close();

    await expect(
      importSessionReviewReceipt({
        cwd: fixture.repoDir,
        sessionId: fixture.sessionId,
        packagePath: path.join(fixture.inputDir, 'unread-package.json'),
      }),
    ).rejects.toMatchObject({
      code: 'AUDIT_VERIFICATION_FAILED',
      details: {
        session_id: fixture.sessionId,
        audit_error: { code: 'AUDIT_SEQUENCE_MISMATCH' },
        hint: 'Restore the ledger from trusted storage.',
      },
    });

    const unchanged = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(unchanged.prepare(`SELECT COUNT(*) AS count FROM signed_review_receipts`).get()).toEqual({ count: 0 });
      expect(unchanged.prepare(`SELECT COUNT(*) AS count FROM audit_events`).get()).toEqual({ count: 0 });
    } finally {
      unchanged.close();
    }
  });

  it('rejects task-projection drift before importing signed review evidence', async () => {
    const fixture = await makeReviewingSession();
    const artifact = reviewArtifact(fixture);
    const packagePath = await writePackage(fixture, artifact);
    await resetSqliteConnections(fixture.repoDir);
    const dbPath = path.join(fixture.repoDir, '.threadloop/state/state.db');
    const corrupt = new DatabaseSync(dbPath);
    corrupt.prepare(`UPDATE tasks SET state_version = 7`).run();
    const beforeAuditCount = (
      corrupt.prepare(`SELECT COUNT(*) AS count FROM audit_events WHERE session_id = ?`).get(fixture.sessionId) as {
        count: number;
      }
    ).count;
    corrupt.close();

    await expect(
      importSessionReviewReceipt({
        cwd: fixture.repoDir,
        sessionId: fixture.sessionId,
        packagePath,
        verifyReceipt: () => verifier(artifact),
      }),
    ).rejects.toMatchObject({
      code: 'STATE_CORRUPTED',
      details: {
        session_id: fixture.sessionId,
        hint: 'Restore transition history from trusted storage before retrying the receipt import.',
      },
    });

    const unchanged = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(unchanged.prepare(`SELECT COUNT(*) AS count FROM signed_review_receipts`).get()).toEqual({ count: 0 });
      expect(
        unchanged.prepare(`SELECT COUNT(*) AS count FROM audit_events WHERE session_id = ?`).get(fixture.sessionId),
      ).toEqual({ count: beforeAuditCount });
    } finally {
      unchanged.close();
    }
  });

  it('rejects a stale reviewed HEAD without persisting or promoting the package', async () => {
    const fixture = await makeReviewingSession();
    const artifact = reviewArtifact(fixture, {
      pull_request: {
        ...reviewArtifact(fixture).pull_request,
        head_sha: '9'.repeat(40),
      },
    });
    const packagePath = await writePackage(fixture, artifact);

    await expect(
      importSessionReviewReceipt({
        cwd: fixture.repoDir,
        sessionId: fixture.sessionId,
        packagePath,
        verifyReceipt: () => verifier(artifact),
      }),
    ).rejects.toMatchObject({ code: 'SIGNED_RECEIPT_HEAD_MISMATCH' });

    const db = new DatabaseSync(path.join(fixture.repoDir, '.threadloop/state/state.db'), { readOnly: true });
    try {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM signed_review_receipts`).get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it('rejects malformed and oversized packages before signature verification', async () => {
    const fixture = await makeReviewingSession();
    const malformedPath = path.join(fixture.inputDir, 'malformed.json');
    const oversizedPath = path.join(fixture.inputDir, 'oversized.json');
    await writeFile(malformedPath, '{not-json', 'utf8');
    await writeFile(oversizedPath, Buffer.alloc(10 * 1024 * 1024 + 1, 0x20));

    await expect(
      importSessionReviewReceipt({
        cwd: fixture.repoDir,
        sessionId: fixture.sessionId,
        packagePath: malformedPath,
        verifyReceipt: () => {
          throw new Error('signature verification must not run');
        },
      }),
    ).rejects.toMatchObject({ code: 'SIGNED_RECEIPT_INVALID' });
    await expect(
      importSessionReviewReceipt({
        cwd: fixture.repoDir,
        sessionId: fixture.sessionId,
        packagePath: oversizedPath,
        verifyReceipt: () => {
          throw new Error('signature verification must not run');
        },
      }),
    ).rejects.toMatchObject({ code: 'SIGNED_RECEIPT_INVALID' });
    expect(reviewReceiptCount(fixture.repoDir)).toBe(0);
  });

  it.each([
    ['signature_invalid', 'SIGNED_RECEIPT_SIGNATURE_INVALID'],
    ['transparency_missing', 'SIGNED_RECEIPT_TRANSPARENCY_MISSING'],
  ] as const)('rejects %s verification failures without persistence', async (reason, code) => {
    const fixture = await makeReviewingSession();
    const artifact = reviewArtifact(fixture);
    const packagePath = await writePackage(fixture, artifact);

    await expect(
      importSessionReviewReceipt({
        cwd: fixture.repoDir,
        sessionId: fixture.sessionId,
        packagePath,
        verifyReceipt: () => Promise.reject(new SigstoreReceiptVerificationError(reason, `fixture ${reason}`)),
      }),
    ).rejects.toMatchObject({ code });
    expect(reviewReceiptCount(fixture.repoDir)).toBe(0);
  });

  it('rejects a verified signer projection that disagrees with the signed review artifact', async () => {
    const fixture = await makeReviewingSession();
    const artifact = reviewArtifact(fixture);
    const packagePath = await writePackage(fixture, artifact);

    await expect(
      importSessionReviewReceipt({
        cwd: fixture.repoDir,
        sessionId: fixture.sessionId,
        packagePath,
        verifyReceipt: async () => ({
          ...(await verifier(artifact)),
          sourceRef: 'refs/heads/untrusted',
        }),
      }),
    ).rejects.toMatchObject({ code: 'SIGNED_RECEIPT_IDENTITY_MISMATCH' });
    expect(reviewReceiptCount(fixture.repoDir)).toBe(0);
  });

  it('rejects the same receipt id with different bytes and preserves the authoritative package', async () => {
    const fixture = await makeReviewingSession();
    const firstArtifact = reviewArtifact(fixture);
    const packagePath = await writePackage(fixture, firstArtifact);
    const imported = await importSessionReviewReceipt({
      cwd: fixture.repoDir,
      sessionId: fixture.sessionId,
      packagePath,
      verifyReceipt: () => verifier(firstArtifact),
    });
    const authoritativeBytes = await readFile(path.join(fixture.repoDir, imported.receipt.package.path));
    const conflictingArtifact = {
      ...firstArtifact,
      observed_at: '2026-07-26T12:05:00.000Z',
    };
    await writePackage(fixture, conflictingArtifact);

    await expect(
      importSessionReviewReceipt({
        cwd: fixture.repoDir,
        sessionId: fixture.sessionId,
        packagePath,
        verifyReceipt: () => verifier(conflictingArtifact),
      }),
    ).rejects.toMatchObject({ code: 'SIGNED_RECEIPT_CONFLICT' });
    expect(reviewReceiptCount(fixture.repoDir)).toBe(1);
    expect(await readFile(path.join(fixture.repoDir, imported.receipt.package.path))).toEqual(authoritativeBytes);
  });

  it('serializes concurrent identical imports into one receipt and one audit event', async () => {
    const fixture = await makeReviewingSession();
    const artifact = reviewArtifact(fixture);
    const packagePath = await writePackage(fixture, artifact);

    const results = await Promise.all([
      importSessionReviewReceipt({
        cwd: fixture.repoDir,
        sessionId: fixture.sessionId,
        packagePath,
        verifyReceipt: () => verifier(artifact),
      }),
      importSessionReviewReceipt({
        cwd: fixture.repoDir,
        sessionId: fixture.sessionId,
        packagePath,
        verifyReceipt: () => verifier(artifact),
      }),
    ]);

    expect(results.map((result) => result.already_imported).sort()).toEqual([false, true]);
    expect(reviewReceiptCount(fixture.repoDir)).toBe(1);
    expect(auditReviewImportCount(fixture.repoDir)).toBe(1);
  });

  it('removes a newly promoted final package when the enclosing transaction fails', async () => {
    const fixture = await makeReviewingSession();
    const artifact = reviewArtifact(fixture);
    const packagePath = await writePackage(fixture, artifact);
    const finalPackagePath = path.join(
      fixture.repoDir,
      '.threadloop',
      'artifacts',
      'receipts',
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
        verifyReceipt: () => verifier(artifact),
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
    expect(auditReviewImportCount(fixture.repoDir)).toBe(0);
    expect(existsSync(finalPackagePath)).toBe(false);
  });

  it('projects a corrupted controlled review package as corrupt and blocks progression safely', async () => {
    const fixture = await makeAuthoritativeReviewingSession();
    const artifact = reviewArtifact(fixture, { receipt_id: 'review_corrupt_after_import' });
    const packagePath = await writePackage(fixture, artifact);
    const imported = await importSessionReviewReceipt({
      cwd: fixture.repoDir,
      sessionId: fixture.sessionId,
      packagePath,
      verifyReceipt: () => verifier(artifact),
    });
    await writeFile(
      path.join(fixture.repoDir, imported.receipt.package.path),
      Buffer.alloc(10 * 1024 * 1024 + 1, 0x20),
    );

    const next = parseJson<{
      data: {
        lifecycle: { state: string; state_version: number };
        candidate: { target_state: string; executable: boolean };
        review: { status: string };
        required_work: Array<{ code: string }>;
      };
    }>((await runCli(fixture.repoDir, ['session', 'next', '--session', fixture.sessionId, '--json'])).stdout);
    expect(next.data).toMatchObject({
      lifecycle: { state: 'reviewing', state_version: 6 },
      candidate: { target_state: 'ready_for_human', executable: false },
      review: { status: 'corrupt' },
      required_work: [{ code: 'RESTORE_SIGNED_REVIEW_PROOF' }],
    });

    const rejected = await transitionSessionFailure(
      fixture.repoDir,
      fixture.sessionId,
      'ready_for_human',
      6,
      'review:corrupt-package',
    );
    expect(rejected).toMatchObject({
      error: {
        code: 'TRANSITION_GUARD_FAILED',
        details: { guard_failures: [{ code: 'UNCORRUPTED_REVIEW_PROOF_REQUIRED' }] },
      },
    });
    expect(readLifecycle(fixture.repoDir)).toEqual({ status: 'reviewing', state_version: 6 });
  });

  it('forbids implementation re-entry after the pre-PR phase closes', async () => {
    const fixture = await makeAuthoritativeReviewingSession();
    const rejected = await transitionSessionFailure(
      fixture.repoDir,
      fixture.sessionId,
      'implementing',
      6,
      'post-pr:implementation-reentry',
    );
    expect(rejected).toMatchObject({
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
    const cleanArtifact = reviewArtifact(fixture, { receipt_id: 'review_clean_before_late_finding' });
    const cleanPackagePath = await writePackage(fixture, cleanArtifact);
    await importSessionReviewReceipt({
      cwd: fixture.repoDir,
      sessionId: fixture.sessionId,
      packagePath: cleanPackagePath,
      verifyReceipt: () => verifier(cleanArtifact),
    });
    await transitionSession(fixture.repoDir, fixture.sessionId, 'ready_for_human', 6, 'review:ready');

    const lateFinding = blockingReviewArtifact(
      fixture,
      'review_late_blocker',
      'A late current-HEAD finding must reopen bounded repair',
    );
    const latePackagePath = await writePackage(fixture, lateFinding);
    await importSessionReviewReceipt({
      cwd: fixture.repoDir,
      sessionId: fixture.sessionId,
      packagePath: latePackagePath,
      verifyReceipt: () => verifier(lateFinding),
    });

    const next = parseJson<{
      data: {
        candidate: { target_state: string; executable: boolean };
        review: { status: string; blocking_findings: Array<{ id: string }> };
      };
    }>((await runCli(fixture.repoDir, ['session', 'next', '--session', fixture.sessionId, '--json'])).stdout);
    expect(next.data).toMatchObject({
      candidate: { target_state: 'repairing', executable: true },
      review: {
        status: 'current',
        blocking_findings: [{ id: 'thread-review_late_blocker' }],
      },
    });

    await transitionSession(fixture.repoDir, fixture.sessionId, 'repairing', 7, 'review:late-repair');
    expect(readLifecycle(fixture.repoDir)).toEqual({ status: 'repairing', state_version: 8 });
  });

  it('rejects a wrong-HEAD approval, then completes through public transitions after current approval and merge evidence', async () => {
    const fixture = await makeAuthoritativeReviewingSession();
    const wrongHeadArtifact = reviewArtifact(fixture, {
      receipt_id: 'review_merged_wrong_head',
      pull_request: {
        ...reviewArtifact(fixture).pull_request,
        merged: true,
        merged_at: '2026-07-26T12:00:00.000Z',
      },
      review: {
        decision: 'APPROVED',
        approvals: [
          {
            ...reviewArtifact(fixture).review.approvals[0]!,
            commit_sha: '9'.repeat(40),
          },
        ],
        threads: [],
      },
    });
    const wrongHeadPackagePath = await writePackage(fixture, wrongHeadArtifact);
    await importSessionReviewReceipt({
      cwd: fixture.repoDir,
      sessionId: fixture.sessionId,
      packagePath: wrongHeadPackagePath,
      verifyReceipt: () => verifier(wrongHeadArtifact),
    });
    await transitionSession(fixture.repoDir, fixture.sessionId, 'ready_for_human', 6, 'review:human-authority');

    const wrongHeadCompletion = await transitionSessionFailure(
      fixture.repoDir,
      fixture.sessionId,
      'completed',
      7,
      'review:wrong-head-completion',
    );
    expect(wrongHeadCompletion).toMatchObject({
      error: {
        code: 'TRANSITION_GUARD_FAILED',
        details: { guard_failures: [{ code: 'CURRENT_HUMAN_APPROVAL_REQUIRED' }] },
      },
    });
    expect(readLifecycle(fixture.repoDir)).toEqual({ status: 'ready_for_human', state_version: 7 });

    const approvedMergedArtifact = reviewArtifact(fixture, {
      receipt_id: 'review_merged_current_head',
      pull_request: {
        ...reviewArtifact(fixture).pull_request,
        merged: true,
        merged_at: '2026-07-26T12:05:00.000Z',
      },
      observed_at: '2026-07-26T12:06:00.000Z',
    });
    const approvedMergedPackagePath = await writePackage(fixture, approvedMergedArtifact);
    await importSessionReviewReceipt({
      cwd: fixture.repoDir,
      sessionId: fixture.sessionId,
      packagePath: approvedMergedPackagePath,
      verifyReceipt: () => verifier(approvedMergedArtifact),
    });

    const completed = parseJson<{
      data: {
        lifecycle: { state: string; state_version: number };
        session: { ended_at: string | null };
      };
    }>(
      (await transitionSession(fixture.repoDir, fixture.sessionId, 'completed', 7, 'review:approved-merged-completion'))
        .stdout,
    );
    expect(completed.data).toMatchObject({
      lifecycle: { state: 'completed', state_version: 8 },
    });
    expect(completed.data.session.ended_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(readLifecycle(fixture.repoDir)).toEqual({ status: 'completed', state_version: 8 });
  });

  it('counts persisted review and gate repair entries together and rejects a fourth review repair', async () => {
    const gateCommand = [
      'node',
      '-e',
      `const { readFileSync } = require('node:fs'); process.exit(readFileSync('gate-mode.txt', 'utf8').trim() === 'pass' ? 0 : 1);`,
    ];
    const fixture = await makeAuthoritativeReviewingSession(gateCommand);
    const firstReviewBlocker = blockingReviewArtifact(fixture, 'review_budget_first', 'Open the review repair cycle');
    const firstReviewPackagePath = await writePackage(fixture, firstReviewBlocker);
    await importSessionReviewReceipt({
      cwd: fixture.repoDir,
      sessionId: fixture.sessionId,
      packagePath: firstReviewPackagePath,
      verifyReceipt: () => verifier(firstReviewBlocker),
    });
    await transitionSession(fixture.repoDir, fixture.sessionId, 'repairing', 6, 'budget:review-repair');

    await writeFile(path.join(fixture.repoDir, 'gate-mode.txt'), 'fail\n', 'utf8');
    await writeFile(path.join(fixture.repoDir, 'repairs.txt'), 'review repair\n', 'utf8');
    await commitFixtureChanges(fixture, 'repair review finding', ['gate-mode.txt', 'repairs.txt']);
    await transitionSession(fixture.repoDir, fixture.sessionId, 'verifying', 7, 'budget:first-verify');
    await runCli(fixture.repoDir, ['session', 'gate', 'run', 'check', '--session', fixture.sessionId, '--json']);
    await transitionSession(fixture.repoDir, fixture.sessionId, 'repairing', 8, 'budget:first-gate-repair');

    await writeFile(path.join(fixture.repoDir, 'repairs.txt'), 'first gate repair\n', { flag: 'a' });
    await commitFixtureChanges(fixture, 'repair first gate failure', ['repairs.txt']);
    await transitionSession(fixture.repoDir, fixture.sessionId, 'verifying', 9, 'budget:second-verify');
    await runCli(fixture.repoDir, ['session', 'gate', 'run', 'check', '--session', fixture.sessionId, '--json']);
    await transitionSession(fixture.repoDir, fixture.sessionId, 'repairing', 10, 'budget:second-gate-repair');

    await writeFile(path.join(fixture.repoDir, 'gate-mode.txt'), 'pass\n', 'utf8');
    await writeFile(path.join(fixture.repoDir, 'repairs.txt'), 'second gate repair\n', { flag: 'a' });
    await commitFixtureChanges(fixture, 'repair second gate failure', ['gate-mode.txt', 'repairs.txt']);
    await transitionSession(fixture.repoDir, fixture.sessionId, 'verifying', 11, 'budget:third-verify');
    await runCli(fixture.repoDir, ['session', 'gate', 'run', 'check', '--session', fixture.sessionId, '--json']);
    await importCurrentSignedGate(fixture, 'receipt_signed_after_three_repairs');
    await transitionSession(fixture.repoDir, fixture.sessionId, 'reviewing', 12, 'budget:return-to-review');

    const fourthReviewBlocker = blockingReviewArtifact(
      fixture,
      'review_budget_fourth',
      'A fourth repair must be rejected',
    );
    const fourthReviewPackagePath = await writePackage(fixture, fourthReviewBlocker);
    await importSessionReviewReceipt({
      cwd: fixture.repoDir,
      sessionId: fixture.sessionId,
      packagePath: fourthReviewPackagePath,
      verifyReceipt: () => verifier(fourthReviewBlocker),
    });

    const rejected = await transitionSessionFailure(
      fixture.repoDir,
      fixture.sessionId,
      'repairing',
      13,
      'budget:fourth-review-repair',
    );
    expect(rejected).toMatchObject({
      error: {
        code: 'TRANSITION_GUARD_FAILED',
        details: { guard_failures: [{ code: 'REPAIR_BUDGET_EXHAUSTED' }] },
      },
    });
    expect(readLifecycle(fixture.repoDir)).toEqual({ status: 'reviewing', state_version: 13 });
    expect(repairTransitionCount(fixture.repoDir)).toBe(3);
  });

  it('requires a descendant commit after the exact evidence that opened each repair cycle', async () => {
    const fixture = await makeAuthoritativeReviewingSession([
      'node',
      '-e',
      `const { readFileSync } = require('node:fs'); process.exit(readFileSync('gate-mode.txt', 'utf8').trim() === 'pass' ? 0 : 1);`,
    ]);
    const reviewHead = fixture.head;
    const blockingArtifact = reviewArtifact(fixture, {
      review: {
        decision: 'CHANGES_REQUESTED',
        approvals: [],
        threads: [
          {
            id: 'thread-review-cycle',
            url: `${sourceRepository}/pull/42#discussion_review_cycle`,
            author_login: 'reviewer',
            author_type: 'User',
            body: 'Open the first repair cycle',
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
    const packagePath = await writePackage(fixture, blockingArtifact);
    await importSessionReviewReceipt({
      cwd: fixture.repoDir,
      sessionId: fixture.sessionId,
      packagePath,
      verifyReceipt: () => verifier(blockingArtifact),
    });
    await transitionSession(fixture.repoDir, fixture.sessionId, 'repairing', 6, 'review-cycle:open');

    await writeFile(path.join(fixture.repoDir, 'repair.txt'), 'review repair\n', 'utf8');
    await writeFile(path.join(fixture.repoDir, 'gate-mode.txt'), 'fail\n', 'utf8');
    await execFileAsync('git', ['add', 'repair.txt', 'gate-mode.txt'], { cwd: fixture.repoDir });
    await execFileAsync('git', ['commit', '-m', 'repair review finding'], { cwd: fixture.repoDir });
    await transitionSession(fixture.repoDir, fixture.sessionId, 'verifying', 7, 'review-cycle:verify');
    const gateFailureHead = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: fixture.repoDir })).stdout.trim();
    expect(gateFailureHead).not.toBe(reviewHead);

    await runCli(fixture.repoDir, ['session', 'gate', 'run', 'check', '--session', fixture.sessionId, '--json']);
    await transitionSession(fixture.repoDir, fixture.sessionId, 'repairing', 8, 'gate-cycle:open');

    const immediateRetry = await transitionSessionFailure(
      fixture.repoDir,
      fixture.sessionId,
      'verifying',
      9,
      'gate-cycle:no-repair',
    );
    expect(immediateRetry).toMatchObject({
      error: {
        code: 'TRANSITION_GUARD_FAILED',
        details: { guard_failures: [{ code: 'COMMITTED_REPAIR_REQUIRED' }] },
      },
    });

    await writeFile(path.join(fixture.repoDir, 'repair.txt'), 'gate repair\n', { flag: 'a' });
    await execFileAsync('git', ['add', 'repair.txt'], { cwd: fixture.repoDir });
    await execFileAsync('git', ['commit', '-m', 'repair newer gate failure'], { cwd: fixture.repoDir });
    await execFileAsync('git', ['reset', '--hard', reviewHead], { cwd: fixture.repoDir });

    const ancestorRollback = await transitionSessionFailure(
      fixture.repoDir,
      fixture.sessionId,
      'verifying',
      9,
      'gate-cycle:ancestor-rollback',
    );
    expect(ancestorRollback).toMatchObject({
      error: {
        code: 'TRANSITION_GUARD_FAILED',
        details: { guard_failures: [{ code: 'COMMITTED_REPAIR_REQUIRED' }] },
      },
    });
  });
});

function reviewReceiptCount(repoDir: string) {
  const db = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'), { readOnly: true });
  try {
    return (db.prepare(`SELECT COUNT(*) AS count FROM signed_review_receipts`).get() as { count: number }).count;
  } finally {
    db.close();
  }
}

function auditReviewImportCount(repoDir: string) {
  const db = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'), { readOnly: true });
  try {
    return (
      db
        .prepare(`SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'signed_review_receipt_imported'`)
        .get() as { count: number }
    ).count;
  } finally {
    db.close();
  }
}

function readLifecycle(repoDir: string) {
  const db = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'), { readOnly: true });
  try {
    return db.prepare(`SELECT status, state_version FROM tasks`).get() as {
      status: string;
      state_version: number;
    };
  } finally {
    db.close();
  }
}

function repairTransitionCount(repoDir: string) {
  const db = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'), { readOnly: true });
  try {
    return (
      db.prepare(`SELECT COUNT(*) AS count FROM session_transitions WHERE to_state = 'repairing'`).get() as {
        count: number;
      }
    ).count;
  } finally {
    db.close();
  }
}

async function commitFixtureChanges(fixture: ReviewFixture, message: string, files: string[]) {
  await execFileAsync('git', ['add', ...files], { cwd: fixture.repoDir });
  await execFileAsync('git', ['commit', '-m', message], { cwd: fixture.repoDir });
  fixture.head = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: fixture.repoDir })).stdout.trim();
}

async function transitionSession(
  repoDir: string,
  sessionId: string,
  targetState: string,
  expectedVersion: number,
  idempotencyKey: string,
  input: Record<string, unknown> = {},
) {
  return runCli(repoDir, [
    'session',
    'transition',
    targetState,
    '--session',
    sessionId,
    '--expected-state-version',
    String(expectedVersion),
    '--idempotency-key',
    idempotencyKey,
    '--actor',
    'agent',
    '--input',
    JSON.stringify(input),
    '--json',
  ]);
}

async function transitionSessionFailure(
  repoDir: string,
  sessionId: string,
  targetState: string,
  expectedVersion: number,
  idempotencyKey: string,
) {
  try {
    await transitionSession(repoDir, sessionId, targetState, expectedVersion, idempotencyKey);
    throw new Error(`Expected ${targetState} transition to fail.`);
  } catch (error) {
    return parseJson<{
      error: {
        code: string;
        details: Record<string, unknown> & { guard_failures?: Array<{ code: string }> };
      };
    }>((error as Error & { stderr?: string }).stderr);
  }
}
