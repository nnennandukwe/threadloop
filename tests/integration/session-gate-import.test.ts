import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCliError, runGate, sessionNext } from '../helpers/cli.js';
import {
  cleanupTemporaryState,
  commitFiles,
  makeTempDir,
  makeVerifyingSession,
  proofPlan,
} from '../helpers/session.js';
import { countRows, deleteAuditLedger, readLifecycle, withStateDb } from '../helpers/state-db.js';
import {
  boundGateArtifact,
  fixtureBranch,
  signedGatePackage,
  verifiedSigner,
  writeSignedPackage,
} from '../fixtures/receipts.js';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import { SigstoreReceiptVerificationError, type VerifiedSigstoreSigner } from '../../src/adapters/crypto/sigstore.js';
import { nodeSignedReceiptFileSystem } from '../../src/adapters/fs/signed-receipt-files.js';
import { closeSqliteConnections } from '../../src/adapters/fs/sqlite-store.js';
import type { SignedGateReceiptArtifact } from '../../src/domain/attestation.js';
import { canonicalJson } from '../../src/domain/canonical-json.js';
import type { ProofSetupStep } from '../../src/domain/proof.js';
import {
  getNextSessionAction,
  importSessionGateReceipt as importSessionGateReceiptWithDependencies,
} from '../../src/services/session-service.js';

const TEN_MIB = 10 * 1024 * 1024;

type Fixture = Awaited<ReturnType<typeof makeFixture>>;

/** A verifying session plus a scratch directory for the packages a CI job would hand the operator. */
async function makeFixture(gateSetup?: ProofSetupStep[]) {
  return {
    ...(await makeVerifyingSession({ plan: proofPlan({ setup: gateSetup }) })),
    inputDir: await makeTempDir('threadloop-signed-input-'),
  };
}

function writePackage(fixture: Fixture, artifact = boundGateArtifact(fixture)) {
  return writeSignedPackage(fixture.inputDir, signedGatePackage(artifact));
}

/** Imports through the real bounded file system, trusting the signer `verifyReceipt` reports. */
function importGate(
  fixture: Fixture,
  packagePath: string,
  verifyReceipt: () => Promise<VerifiedSigstoreSigner> = verifiedSigner('gate', boundGateArtifact(fixture)),
) {
  return importSessionGateReceiptWithDependencies({
    cwd: fixture.repoDir,
    sessionId: fixture.sessionId,
    packagePath,
    verifyReceipt,
    receiptFileSystem: nodeSignedReceiptFileSystem,
  });
}

function controlledPackagePath(fixture: Fixture, receiptId = 'receipt_signed_123') {
  return path.join(
    fixture.repoDir,
    '.threadloop/artifacts/receipts',
    fixture.sessionId,
    receiptId,
    'signed-receipt.json',
  );
}

const signedReceiptCount = (fixture: Fixture) => countRows(fixture.repoDir, 'signed_gate_receipts');

afterEach(cleanupTemporaryState);

describe('signed gate receipt import', () => {
  it('rejects an oversized input through the bounded reader before verification or persistence', async () => {
    const fixture = await makeFixture();
    const packagePath = await writePackage(fixture);
    await truncate(packagePath, TEN_MIB + 1);
    // Recorded rather than asserted inside the reader: the importer maps any throw from the reader to
    // SIGNED_RECEIPT_INVALID, which is the expected outcome here, so an in-callback assertion could never fail.
    const boundedReads: Array<{ requestedPath: string; maxBytes: number }> = [];
    let signatureVerificationCalled = false;

    await expect(
      importSessionGateReceiptWithDependencies({
        cwd: fixture.repoDir,
        sessionId: fixture.sessionId,
        packagePath,
        receiptFileSystem: {
          ...nodeSignedReceiptFileSystem,
          readWithinLimit: async (requestedPath: string, maxBytes: number) => {
            boundedReads.push({ requestedPath, maxBytes });
            return nodeSignedReceiptFileSystem.readWithinLimit(requestedPath, maxBytes);
          },
        },
        verifyReceipt: () => {
          signatureVerificationCalled = true;
          return verifiedSigner('gate', boundGateArtifact(fixture))();
        },
      }),
    ).rejects.toMatchObject({ code: 'SIGNED_RECEIPT_INVALID' });

    expect(boundedReads).toEqual([{ requestedPath: packagePath, maxBytes: TEN_MIB }]);
    expect(signatureVerificationCalled).toBe(false);
    expect(signedReceiptCount(fixture)).toBe(0);
    expect(readLifecycle(fixture.repoDir)).toEqual({ status: 'verifying', state_version: 4 });
  });

  it('identifies an unreadable package path and tells the operator to provide a readable regular file', async () => {
    const fixture = await makeFixture();
    const missingPath = path.join(fixture.inputDir, 'missing-signed-receipt.json');

    expect(
      await runCliError(fixture.repoDir, [
        'session',
        'gate',
        'import',
        missingPath,
        '--session',
        fixture.sessionId,
        '--json',
      ]),
    ).toMatchObject({
      error: {
        code: 'SIGNED_RECEIPT_INVALID',
        details: {
          package_path: missingPath,
          hint: 'Provide a readable regular file containing the signed receipt package.',
        },
      },
    });
  });

  it('maps a missing audit genesis before importing signed gate evidence', async () => {
    const fixture = await makeFixture();
    closeSqliteConnections(fixture.repoDir);
    deleteAuditLedger(fixture.repoDir, fixture.sessionId);

    await expect(importGate(fixture, path.join(fixture.inputDir, 'unread-package.json'))).rejects.toMatchObject({
      code: 'AUDIT_VERIFICATION_FAILED',
      details: {
        session_id: fixture.sessionId,
        audit_error: { code: 'AUDIT_SEQUENCE_MISMATCH' },
        hint: 'Restore the ledger from trusted storage.',
      },
    });
    expect(signedReceiptCount(fixture)).toBe(0);
    expect(countRows(fixture.repoDir, 'audit_events')).toBe(0);
  });

  it('rejects task-projection drift before importing signed gate evidence', async () => {
    const fixture = await makeFixture();
    const packagePath = await writePackage(fixture);
    closeSqliteConnections(fixture.repoDir);
    withStateDb(fixture.repoDir, (db) => db.prepare(`UPDATE tasks SET state_version = 5`).run(), { readOnly: false });
    const auditCount = countRows(fixture.repoDir, 'audit_events');

    await expect(importGate(fixture, packagePath)).rejects.toMatchObject({
      code: 'STATE_CORRUPTED',
      details: {
        session_id: fixture.sessionId,
        hint: 'Restore transition history from trusted storage before retrying the receipt import.',
      },
    });
    expect(signedReceiptCount(fixture)).toBe(0);
    expect(countRows(fixture.repoDir, 'audit_events')).toBe(auditCount);
  });

  it('imports one verified package idempotently without advancing lifecycle state', async () => {
    const fixture = await makeFixture();
    const packagePath = await writePackage(fixture);
    await runGate(fixture.repoDir, fixture.sessionId);

    const first = await importGate(fixture, packagePath);
    const duplicate = await importGate(fixture, packagePath);

    expect(first).toMatchObject({
      contract_version: 1,
      receipt: {
        id: 'receipt_signed_123',
        sequence: 1,
        gate_id: 'check',
        subject_head_sha: fixture.head,
        result: 'passed',
      },
      already_imported: false,
      lifecycle: { state: 'verifying', state_version: 4 },
    });
    expect(duplicate).toMatchObject({ receipt: { id: 'receipt_signed_123', sequence: 1 }, already_imported: true });
    expect(first.receipt.package.path).toBe(path.relative(fixture.repoDir, controlledPackagePath(fixture)));
    expect(sha256(await readFile(path.join(fixture.repoDir, first.receipt.package.path)))).toBe(
      first.receipt.package.sha256,
    );
    expect(await sessionNext(fixture.repoDir, fixture.sessionId)).toMatchObject({
      contract_version: 4,
      candidate: { target_state: 'pre_pr_reviewing', executable: true },
      proof: { status: 'passed' },
      ci_proof: { status: 'passed', gates: [{ status: 'passed', receipt_id: 'receipt_signed_123' }] },
    });

    closeSqliteConnections(fixture.repoDir);
    withStateDb(fixture.repoDir, (db) =>
      expect(db.prepare(`SELECT value FROM metadata WHERE key = 'schema_version'`).get()).toEqual({ value: '8' }),
    );
    expect(signedReceiptCount(fixture)).toBe(1);
    expect(readLifecycle(fixture.repoDir)).toEqual({ status: 'verifying', state_version: 4 });
    withStateDb(
      fixture.repoDir,
      (db) => {
        const immutable = 'signed gate receipts are immutable';
        expect(() => db.prepare(`UPDATE signed_gate_receipts SET gate_id = 'other'`).run()).toThrow(immutable);
        expect(() => db.prepare(`DELETE FROM signed_gate_receipts`).run()).toThrow(immutable);
        expect(() =>
          db.prepare(`INSERT OR REPLACE INTO signed_gate_receipts SELECT * FROM signed_gate_receipts`).run(),
        ).toThrow(immutable);
        expect(() =>
          db
            .prepare(
              `
                INSERT OR REPLACE INTO signed_gate_receipts (
                  sequence, id, session_id, gate_id, plan_sha256, subject_head_sha, result,
                  package_path, package_sha256, artifact_json, artifact_sha256, statement_json,
                  statement_sha256, issuer, certificate_identity, build_signer_uri, build_signer_sha,
                  source_repository, source_ref, run_invocation_uri, state_version, verified_at
                )
                SELECT
                  sequence + 100, id || '_other', session_id, gate_id, plan_sha256, subject_head_sha, result,
                  package_path, package_sha256, artifact_json, artifact_sha256, statement_json,
                  statement_sha256, issuer, certificate_identity, build_signer_uri, build_signer_sha,
                  source_repository, source_ref, run_invocation_uri, state_version, verified_at
                FROM signed_gate_receipts
              `,
            )
            .run(),
        ).toThrow(immutable);
      },
      { readOnly: false },
    );
  });

  it('adopts a matching unindexed package left by an interrupted promotion', async () => {
    const fixture = await makeFixture();
    const packagePath = await writePackage(fixture);
    const finalPackagePath = controlledPackagePath(fixture);
    await mkdir(path.dirname(finalPackagePath), { recursive: true });
    await writeFile(finalPackagePath, canonicalJson(JSON.parse(await readFile(packagePath, 'utf8')) as unknown));

    const imported = await importGate(fixture, packagePath);

    expect(imported).toMatchObject({
      receipt: { id: 'receipt_signed_123', sequence: 1 },
      already_imported: false,
      ci_proof: { status: 'passed' },
    });
    expect(sha256(await readFile(finalPackagePath))).toBe(imported.receipt.package.sha256);
    expect(signedReceiptCount(fixture)).toBe(1);
  });

  it('rejects a mismatched unindexed package without a row or overwrite', async () => {
    const fixture = await makeFixture();
    const packagePath = await writePackage(fixture);
    const finalPackagePath = controlledPackagePath(fixture);
    const unindexedBytes = Buffer.from('unindexed package\n');
    await mkdir(path.dirname(finalPackagePath), { recursive: true });
    await writeFile(finalPackagePath, unindexedBytes);

    await expect(importGate(fixture, packagePath)).rejects.toMatchObject({ code: 'SIGNED_RECEIPT_CONFLICT' });
    expect(await readFile(finalPackagePath)).toEqual(unindexedBytes);
    expect(signedReceiptCount(fixture)).toBe(0);
  });

  it('rejects an oversized unindexed package before hashing it', async () => {
    const fixture = await makeFixture();
    const packagePath = await writePackage(fixture);
    const finalPackagePath = controlledPackagePath(fixture);
    await mkdir(path.dirname(finalPackagePath), { recursive: true });
    await writeFile(finalPackagePath, '');
    await truncate(finalPackagePath, TEN_MIB + 1);

    await expect(importGate(fixture, packagePath)).rejects.toMatchObject({ code: 'SIGNED_RECEIPT_CONFLICT' });
    expect((await stat(finalPackagePath)).size).toBe(TEN_MIB + 1);
    expect(signedReceiptCount(fixture)).toBe(0);
  });

  it('rejects a setup failure distinctly from a code failure, so an operator sees a broken environment', async () => {
    const syncStep = {
      id: 'sync',
      command: ['uv', 'sync', '--all-groups', '--frozen'],
      working_directory: '.',
      timeout_ms: 600_000,
    };
    const fixture = await makeFixture([syncStep]);
    const setupFailed = boundGateArtifact(fixture, {
      receipt_id: 'receipt_signed_setup_failed',
      result: 'setup_failed',
      exit_status: null,
      setup: [
        {
          ...syncStep,
          result: 'failed',
          started_at: '2026-07-23T18:00:00.000Z',
          ended_at: '2026-07-23T18:00:05.000Z',
          duration_ms: 5_000,
          exit_status: 127,
          signal: null,
          head_before: fixture.head,
          head_after: fixture.head,
          clean_before: true,
          clean_after: true,
          output: { stdout_sha256: 'e'.repeat(64), stderr_sha256: 'f'.repeat(64) },
        },
      ],
    });

    await expect(
      importGate(fixture, await writePackage(fixture, setupFailed), verifiedSigner('gate', setupFailed)),
    ).rejects.toMatchObject({
      code: 'SIGNED_RECEIPT_SETUP_FAILED',
      details: { setup_step_id: 'sync', setup_step_exit_status: 127 },
    });
    // Nothing enters session state: only a passing receipt is ever authoritative.
    expect(signedReceiptCount(fixture)).toBe(0);
  });

  it('does not repair a missing controlled package during duplicate import', async () => {
    const fixture = await makeFixture();
    const packagePath = await writePackage(fixture);
    const first = await importGate(fixture, packagePath);
    const finalPackagePath = path.join(fixture.repoDir, first.receipt.package.path);
    await rm(finalPackagePath);

    await expect(importGate(fixture, packagePath)).rejects.toMatchObject({ code: 'SIGNED_RECEIPT_CONFLICT' });

    expect(existsSync(finalPackagePath)).toBe(false);
    expect(await sessionNext(fixture.repoDir, fixture.sessionId)).toMatchObject({
      ci_proof: { status: 'corrupt', gates: [{ status: 'corrupt' }] },
    });
  });

  it('rejects a genuinely verified failing gate without a row or retained final package', async () => {
    const fixture = await makeFixture();
    const failed = boundGateArtifact(fixture, {
      receipt_id: 'receipt_signed_failed',
      result: 'failed',
      exit_status: 1,
    });

    await expect(
      importGate(fixture, await writePackage(fixture, failed), verifiedSigner('gate', failed)),
    ).rejects.toMatchObject({ code: 'SIGNED_RECEIPT_RESULT_REJECTED' });

    expect(existsSync(controlledPackagePath(fixture, 'receipt_signed_failed'))).toBe(false);
    expect(signedReceiptCount(fixture)).toBe(0);
  });

  it('accepts one winner across concurrent identical imports', async () => {
    const fixture = await makeFixture();
    const packagePath = await writePackage(fixture);

    const results = await Promise.all([importGate(fixture, packagePath), importGate(fixture, packagePath)]);

    expect(results.map((result) => result.receipt.sequence)).toEqual([1, 1]);
    expect(results.map((result) => result.already_imported).sort()).toEqual([false, true]);
    expect(signedReceiptCount(fixture)).toBe(1);
  });

  it('rejects a receipt id reused for different verified content', async () => {
    const fixture = await makeFixture();
    const packagePath = await writePackage(fixture);
    const first = await importGate(fixture, packagePath);
    const conflicting = boundGateArtifact(fixture, {
      output: { stdout_sha256: 'e'.repeat(64), stderr_sha256: 'f'.repeat(64) },
    });
    await writePackage(fixture, conflicting);

    await expect(importGate(fixture, packagePath, verifiedSigner('gate', conflicting))).rejects.toMatchObject({
      code: 'SIGNED_RECEIPT_CONFLICT',
    });

    expect(sha256(await readFile(path.join(fixture.repoDir, first.receipt.package.path)))).toBe(
      first.receipt.package.sha256,
    );
    expect(signedReceiptCount(fixture)).toBe(1);
  });

  it.each([
    {
      name: 'another session plan',
      artifact: (): Partial<SignedGateReceiptArtifact> => ({ plan_sha256: 'e'.repeat(64) }),
      code: 'SIGNED_RECEIPT_INVALID',
    },
    {
      name: 'another HEAD',
      artifact: (fixture: Fixture): Partial<SignedGateReceiptArtifact> => ({
        head_before: 'e'.repeat(40),
        head_after: 'e'.repeat(40),
        source: { ...boundGateArtifact(fixture).source, head_sha: 'e'.repeat(40) },
      }),
      code: 'SIGNED_RECEIPT_HEAD_MISMATCH',
    },
    {
      name: 'another source repository',
      artifact: (fixture: Fixture): Partial<SignedGateReceiptArtifact> => ({
        source: {
          repository: 'https://github.com/example/other',
          ref: `refs/heads/${fixtureBranch}`,
          head_sha: fixture.head,
          run_invocation_uri: 'https://github.com/example/other/actions/runs/123/attempts/1',
        },
      }),
      code: 'SIGNED_RECEIPT_IDENTITY_MISMATCH',
    },
  ])('rejects $name before any persistence', async ({ artifact: override, code }) => {
    const fixture = await makeFixture();
    const receiptArtifact = boundGateArtifact(fixture, override(fixture));

    await expect(
      importGate(fixture, await writePackage(fixture, receiptArtifact), verifiedSigner('gate', receiptArtifact)),
    ).rejects.toMatchObject({ code });

    expect(signedReceiptCount(fixture)).toBe(0);
    expect(readLifecycle(fixture.repoDir)).toEqual({ status: 'verifying', state_version: 4 });
  });

  it('maps transparency failures without leaving accepted state', async () => {
    const fixture = await makeFixture();
    const rejectTransparency = () =>
      Promise.reject(new SigstoreReceiptVerificationError('transparency_missing', 'Missing Rekor inclusion proof.'));

    await expect(importGate(fixture, await writePackage(fixture), rejectTransparency)).rejects.toMatchObject({
      code: 'SIGNED_RECEIPT_TRANSPARENCY_MISSING',
    });
    expect(signedReceiptCount(fixture)).toBe(0);
  });

  it('verifies the DSSE signature before rejecting an artifact digest mismatch', async () => {
    const fixture = await makeFixture();
    const packagePath = await writePackage(fixture);
    const value = JSON.parse(await readFile(packagePath, 'utf8')) as { artifact: SignedGateReceiptArtifact };
    value.artifact.output.stdout_sha256 = 'e'.repeat(64);
    await writeFile(packagePath, canonicalJson(value), 'utf8');
    let signatureVerified = false;

    await expect(
      importGate(fixture, packagePath, () => {
        signatureVerified = true;
        return verifiedSigner('gate', boundGateArtifact(fixture))();
      }),
    ).rejects.toMatchObject({ code: 'SIGNED_RECEIPT_ARTIFACT_MISMATCH' });

    expect(signatureVerified).toBe(true);
    expect(signedReceiptCount(fixture)).toBe(0);
  });

  it('reports accepted proof as corrupt after package tampering and stale after HEAD advances', async () => {
    const fixture = await makeFixture();
    const imported = await importGate(fixture, await writePackage(fixture));
    const controlledPath = path.join(fixture.repoDir, imported.receipt.package.path);
    const controlledBytes = await readFile(controlledPath);

    await writeFile(controlledPath, '{}', 'utf8');
    expect(await sessionNext(fixture.repoDir, fixture.sessionId)).toMatchObject({
      ci_proof: { status: 'corrupt', gates: [{ status: 'corrupt' }] },
    });

    await writeFile(controlledPath, controlledBytes);
    await commitFiles(fixture.repoDir, 'advance HEAD', { 'later.txt': 'later\n' });
    expect(await sessionNext(fixture.repoDir, fixture.sessionId)).toMatchObject({
      ci_proof: { status: 'stale', gates: [{ status: 'stale' }] },
    });
  });

  it('revalidates a controlled package through the 10 MiB bounded reader', async () => {
    const fixture = await makeFixture();
    const imported = await importGate(fixture, await writePackage(fixture));
    await truncate(path.join(fixture.repoDir, imported.receipt.package.path), TEN_MIB + 1);

    const originalReadWithinLimit = nodeSignedReceiptFileSystem.readWithinLimit.bind(nodeSignedReceiptFileSystem);
    // Recorded rather than asserted inside the reader, whose throws are mapped to a corrupt read.
    const controlledReads: Array<{ fileName: string; maxBytes: number }> = [];
    nodeSignedReceiptFileSystem.readWithinLimit = async (requestedPath, maxBytes) => {
      controlledReads.push({ fileName: path.basename(requestedPath), maxBytes });
      return originalReadWithinLimit(requestedPath, maxBytes);
    };
    try {
      const next = await getNextSessionAction({ cwd: fixture.repoDir, sessionId: fixture.sessionId });
      expect(next.ci_proof).toMatchObject({ status: 'corrupt', gates: [{ status: 'corrupt' }] });
    } finally {
      nodeSignedReceiptFileSystem.readWithinLimit = originalReadWithinLimit;
    }
    // Every controlled read must be bounded, not merely one of them.
    expect(controlledReads.length).toBeGreaterThan(0);
    expect(controlledReads).toEqual(
      controlledReads.map(() => ({ fileName: 'signed-receipt.json', maxBytes: TEN_MIB })),
    );
  });
});
