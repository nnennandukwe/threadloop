import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import type { VerifiedSigstoreSigner } from '../../src/adapters/crypto/sigstore.js';
import { SigstoreReceiptVerificationError } from '../../src/adapters/crypto/sigstore.js';
import { DatabaseSync } from '../../src/adapters/fs/sqlite-driver.js';
import { nodeSignedReceiptFileSystem } from '../../src/adapters/fs/signed-receipt-files.js';
import { resetSqliteConnections } from '../../src/adapters/fs/sqlite-store.js';
import {
  buildInTotoReceiptStatement,
  canonicalizeSignedGateReceiptArtifact,
  IN_TOTO_PAYLOAD_TYPE,
  SIGNED_RECEIPT_MEDIA_TYPE,
  type SignedGateReceiptArtifact,
} from '../../src/domain/attestation.js';
import { canonicalJson } from '../../src/domain/canonical-json.js';
import {
  importSessionGateReceipt as importSessionGateReceiptWithDependencies,
  type ImportSessionGateReceiptInput,
} from '../../src/services/session-service.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const projectRoot = process.cwd();
const tsxCli = path.join(projectRoot, 'node_modules/tsx/dist/cli.mjs');
const cliEntry = path.join(projectRoot, 'src/cli.ts');
const branch = 'issue-41/signed-ci-receipts';
const sourceRepository = 'https://github.com/example/project';
const buildSignerSha = 'b'.repeat(40);
const buildSignerUri = `https://github.com/nnennandukwe/threadloop/.github/workflows/threadloop-gate-sensor.yml@${buildSignerSha}`;
const certificateIdentity = `${sourceRepository}/.github/workflows/threadloop.yml@refs/heads/${branch}`;

function importSessionGateReceipt(input: Omit<ImportSessionGateReceiptInput, 'receiptFileSystem'>) {
  return importSessionGateReceiptWithDependencies({
    ...input,
    receiptFileSystem: nodeSignedReceiptFileSystem,
  });
}

async function runCli(cwd: string, args: string[]) {
  return execFileAsync('node', [tsxCli, cliEntry, ...args], { cwd });
}

function parseJson<T>(value: string | undefined) {
  return JSON.parse(value ?? '') as T;
}

async function makeVerifyingSession() {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), 'threadloop-signed-import-'));
  const inputDir = await mkdtemp(path.join(os.tmpdir(), 'threadloop-signed-input-'));
  temporaryDirectories.push(repoDir, inputDir);
  await execFileAsync('git', ['init'], { cwd: repoDir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
  await execFileAsync('git', ['remote', 'add', 'origin', `${sourceRepository}.git`], { cwd: repoDir });
  await writeFile(path.join(repoDir, 'README.md'), '# signed receipt fixture\n', 'utf8');
  await execFileAsync('git', ['add', 'README.md'], { cwd: repoDir });
  await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: repoDir });
  await execFileAsync('git', ['branch', '-M', branch], { cwd: repoDir });

  const started = parseJson<{ data: { session_id: string } }>(
    (
      await runCli(repoDir, [
        'session',
        'start',
        'Signed gate task',
        '--goal',
        'Require external CI proof',
        '--issue',
        '#41',
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
    'frame:signed-gate',
    '--actor',
    'agent',
    '--input',
    '{}',
    '--json',
  ]);
  const proofPlan = {
    contract_version: 2,
    acceptance_criteria: ['All checks pass locally and in CI'],
    ci: {
      provider: 'github-actions',
      issuer: 'https://token.actions.githubusercontent.com',
      certificate_identity: certificateIdentity,
      source_repository: sourceRepository,
      build_signer_uri: buildSignerUri,
      build_signer_sha: buildSignerSha,
    },
    gates: [
      {
        id: 'check',
        command: ['node', '-e', 'process.exit(0)'],
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
        'proof:signed-gate',
        '--actor',
        'agent',
        '--input',
        JSON.stringify({ proof_plan: proofPlan }),
        '--json',
      ])
    ).stdout,
  );

  await resetSqliteConnections(repoDir);
  const db = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'));
  try {
    db.prepare(`UPDATE tasks SET status = 'verifying', state_version = 4`).run();
  } finally {
    db.close();
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

function signedArtifact(
  fixture: Awaited<ReturnType<typeof makeVerifyingSession>>,
  overrides: Partial<SignedGateReceiptArtifact> = {},
): SignedGateReceiptArtifact {
  return {
    schema_version: 1,
    receipt_id: 'receipt_signed_123',
    session_id: fixture.sessionId,
    plan_sha256: fixture.planSha256,
    gate: fixture.gate,
    result: 'passed',
    started_at: '2026-07-23T18:00:00.000Z',
    ended_at: '2026-07-23T18:00:01.000Z',
    duration_ms: 1_000,
    exit_status: 0,
    signal: null,
    head_before: fixture.head,
    head_after: fixture.head,
    clean_before: true,
    clean_after: true,
    output: { stdout_sha256: 'c'.repeat(64), stderr_sha256: 'd'.repeat(64) },
    source: {
      repository: sourceRepository,
      ref: `refs/heads/${branch}`,
      head_sha: fixture.head,
      run_invocation_uri: `${sourceRepository}/actions/runs/123/attempts/1`,
    },
    environment: {
      runner_environment: 'github-hosted',
      runner_os: 'Linux',
      runner_arch: 'X64',
      node_version: 'v22.13.0',
    },
    sensor: { name: 'threadloop-github-actions-gate', contract_version: 1 },
    ...overrides,
  };
}

async function writePackage(
  fixture: Awaited<ReturnType<typeof makeVerifyingSession>>,
  receiptArtifact: SignedGateReceiptArtifact,
) {
  const canonicalArtifact = canonicalizeSignedGateReceiptArtifact(receiptArtifact, sha256);
  const statement = buildInTotoReceiptStatement(canonicalArtifact.artifact, canonicalArtifact.sha256);
  const packagePath = path.join(fixture.inputDir, `${receiptArtifact.receipt_id}.json`);
  await writeFile(
    packagePath,
    `${canonicalJson({
      media_type: SIGNED_RECEIPT_MEDIA_TYPE,
      artifact: receiptArtifact,
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
    })}\n`,
    'utf8',
  );
  return packagePath;
}

function controlledPackagePath(
  fixture: Awaited<ReturnType<typeof makeVerifyingSession>>,
  receiptId = 'receipt_signed_123',
) {
  return path.join(
    fixture.repoDir,
    '.threadloop/artifacts/receipts',
    fixture.sessionId,
    receiptId,
    'signed-receipt.json',
  );
}

function verifier(
  fixture: Awaited<ReturnType<typeof makeVerifyingSession>>,
  receiptArtifact?: SignedGateReceiptArtifact,
) {
  return (): Promise<VerifiedSigstoreSigner> =>
    Promise.resolve({
      issuer: 'https://token.actions.githubusercontent.com',
      certificateIdentity,
      buildSignerUri,
      buildSignerSha,
      sourceRepository,
      sourceHeadSha: receiptArtifact?.source.head_sha ?? fixture.head,
      sourceRef: receiptArtifact?.source.ref ?? `refs/heads/${branch}`,
      runnerEnvironment: 'github-hosted',
      runInvocationUri: receiptArtifact?.source.run_invocation_uri ?? `${sourceRepository}/actions/runs/123/attempts/1`,
    });
}

afterEach(async () => {
  await resetSqliteConnections();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('signed gate receipt import', { timeout: 20_000 }, () => {
  it('rejects an oversized input through the bounded reader before verification or persistence', async () => {
    const fixture = await makeVerifyingSession();
    const packagePath = await writePackage(fixture, signedArtifact(fixture));
    const oversizedPackageBytes = 10 * 1024 * 1024 + 1;
    await truncate(packagePath, oversizedPackageBytes);
    let boundedReadCalled = false;
    let signatureVerificationCalled = false;
    const boundedReceiptFileSystem = {
      ...nodeSignedReceiptFileSystem,
      readWithinLimit: async (requestedPath: string, maxBytes: number) => {
        boundedReadCalled = true;
        expect(requestedPath).toBe(packagePath);
        expect(maxBytes).toBe(10 * 1024 * 1024);
        return nodeSignedReceiptFileSystem.readWithinLimit(requestedPath, maxBytes);
      },
    };

    await expect(
      importSessionGateReceiptWithDependencies({
        cwd: fixture.repoDir,
        sessionId: fixture.sessionId,
        packagePath,
        receiptFileSystem: boundedReceiptFileSystem,
        verifyReceipt: () => {
          signatureVerificationCalled = true;
          return verifier(fixture)();
        },
      }),
    ).rejects.toMatchObject({ code: 'SIGNED_RECEIPT_INVALID' });

    expect(boundedReadCalled).toBe(true);
    expect(signatureVerificationCalled).toBe(false);
    const db = new DatabaseSync(path.join(fixture.repoDir, '.threadloop/state/state.db'), { readOnly: true });
    try {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM signed_gate_receipts`).get()).toEqual({ count: 0 });
      expect(db.prepare(`SELECT status, state_version FROM tasks`).get()).toEqual({
        status: 'verifying',
        state_version: 4,
      });
    } finally {
      db.close();
    }
  });

  it('imports one verified package idempotently without advancing lifecycle state', async () => {
    const fixture = await makeVerifyingSession();
    const packagePath = await writePackage(fixture, signedArtifact(fixture));
    await runCli(fixture.repoDir, ['session', 'gate', 'run', 'check', '--session', fixture.sessionId, '--json']);

    const first = await importSessionGateReceipt({
      cwd: fixture.repoDir,
      sessionId: fixture.sessionId,
      packagePath,
      verifyReceipt: verifier(fixture),
    });
    const duplicate = await importSessionGateReceipt({
      cwd: fixture.repoDir,
      sessionId: fixture.sessionId,
      packagePath,
      verifyReceipt: verifier(fixture),
    });

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
    expect(duplicate).toMatchObject({
      receipt: { id: 'receipt_signed_123', sequence: 1 },
      already_imported: true,
    });
    expect(first.receipt.package.path).toMatch(
      new RegExp(`^\\.threadloop/artifacts/receipts/${fixture.sessionId}/receipt_signed_123/signed-receipt\\.json$`),
    );
    expect(sha256(await readFile(path.join(fixture.repoDir, first.receipt.package.path)))).toBe(
      first.receipt.package.sha256,
    );
    const next = parseJson<{
      data: {
        contract_version: number;
        candidate: { target_state: string; executable: boolean };
        proof: { status: string };
        ci_proof: { status: string; gates: Array<{ status: string; receipt_id: string }> };
      };
    }>((await runCli(fixture.repoDir, ['session', 'next', '--session', fixture.sessionId, '--json'])).stdout);
    expect(next.data).toMatchObject({
      contract_version: 2,
      candidate: { target_state: 'reviewing', executable: true },
      proof: { status: 'passed' },
      ci_proof: {
        status: 'passed',
        gates: [{ status: 'passed', receipt_id: 'receipt_signed_123' }],
      },
    });

    await resetSqliteConnections(fixture.repoDir);
    const db = new DatabaseSync(path.join(fixture.repoDir, '.threadloop/state/state.db'), { readOnly: true });
    try {
      expect(db.prepare(`SELECT value FROM metadata WHERE key = 'schema_version'`).get()).toEqual({ value: '5' });
      expect(db.prepare(`SELECT COUNT(*) AS count FROM signed_gate_receipts`).get()).toEqual({ count: 1 });
      expect(db.prepare(`SELECT status, state_version FROM tasks`).get()).toEqual({
        status: 'verifying',
        state_version: 4,
      });
    } finally {
      db.close();
    }
    const immutable = new DatabaseSync(path.join(fixture.repoDir, '.threadloop/state/state.db'));
    try {
      expect(() => immutable.prepare(`UPDATE signed_gate_receipts SET gate_id = 'other'`).run()).toThrow(
        'signed gate receipts are immutable',
      );
      expect(() => immutable.prepare(`DELETE FROM signed_gate_receipts`).run()).toThrow(
        'signed gate receipts are immutable',
      );
      expect(() =>
        immutable
          .prepare(
            `
              INSERT OR REPLACE INTO signed_gate_receipts
              SELECT * FROM signed_gate_receipts
            `,
          )
          .run(),
      ).toThrow('signed gate receipts are immutable');
      expect(() =>
        immutable
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
      ).toThrow('signed gate receipts are immutable');
    } finally {
      immutable.close();
    }
  });

  it('adopts a matching unindexed package left by an interrupted promotion', async () => {
    const fixture = await makeVerifyingSession();
    const packagePath = await writePackage(fixture, signedArtifact(fixture));
    const finalPackagePath = controlledPackagePath(fixture);
    await mkdir(path.dirname(finalPackagePath), { recursive: true });
    await writeFile(finalPackagePath, canonicalJson(JSON.parse(await readFile(packagePath, 'utf8')) as unknown));

    const imported = await importSessionGateReceipt({
      cwd: fixture.repoDir,
      sessionId: fixture.sessionId,
      packagePath,
      verifyReceipt: verifier(fixture),
    });

    expect(imported).toMatchObject({
      receipt: { id: 'receipt_signed_123', sequence: 1 },
      already_imported: false,
      ci_proof: { status: 'passed' },
    });
    expect(sha256(await readFile(finalPackagePath))).toBe(imported.receipt.package.sha256);
    const db = new DatabaseSync(path.join(fixture.repoDir, '.threadloop/state/state.db'), { readOnly: true });
    try {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM signed_gate_receipts`).get()).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it('rejects a mismatched unindexed package without a row or overwrite', async () => {
    const fixture = await makeVerifyingSession();
    const packagePath = await writePackage(fixture, signedArtifact(fixture));
    const finalPackagePath = controlledPackagePath(fixture);
    const unindexedBytes = Buffer.from('unindexed package\n');
    await mkdir(path.dirname(finalPackagePath), { recursive: true });
    await writeFile(finalPackagePath, unindexedBytes);

    await expect(
      importSessionGateReceipt({
        cwd: fixture.repoDir,
        sessionId: fixture.sessionId,
        packagePath,
        verifyReceipt: verifier(fixture),
      }),
    ).rejects.toMatchObject({ code: 'SIGNED_RECEIPT_CONFLICT' });

    expect(await readFile(finalPackagePath)).toEqual(unindexedBytes);
    const db = new DatabaseSync(path.join(fixture.repoDir, '.threadloop/state/state.db'), { readOnly: true });
    try {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM signed_gate_receipts`).get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it('rejects an oversized unindexed package before hashing it', async () => {
    const fixture = await makeVerifyingSession();
    const packagePath = await writePackage(fixture, signedArtifact(fixture));
    const finalPackagePath = controlledPackagePath(fixture);
    const oversizedPackageBytes = 10 * 1024 * 1024 + 1;
    await mkdir(path.dirname(finalPackagePath), { recursive: true });
    await writeFile(finalPackagePath, '');
    await truncate(finalPackagePath, oversizedPackageBytes);

    await expect(
      importSessionGateReceipt({
        cwd: fixture.repoDir,
        sessionId: fixture.sessionId,
        packagePath,
        verifyReceipt: verifier(fixture),
      }),
    ).rejects.toMatchObject({ code: 'SIGNED_RECEIPT_CONFLICT' });

    expect((await stat(finalPackagePath)).size).toBe(oversizedPackageBytes);
    const db = new DatabaseSync(path.join(fixture.repoDir, '.threadloop/state/state.db'), { readOnly: true });
    try {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM signed_gate_receipts`).get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it('does not repair a missing controlled package during duplicate import', async () => {
    const fixture = await makeVerifyingSession();
    const packagePath = await writePackage(fixture, signedArtifact(fixture));
    const first = await importSessionGateReceipt({
      cwd: fixture.repoDir,
      sessionId: fixture.sessionId,
      packagePath,
      verifyReceipt: verifier(fixture),
    });
    const finalPackagePath = path.join(fixture.repoDir, first.receipt.package.path);
    await rm(finalPackagePath);

    await expect(
      importSessionGateReceipt({
        cwd: fixture.repoDir,
        sessionId: fixture.sessionId,
        packagePath,
        verifyReceipt: verifier(fixture),
      }),
    ).rejects.toMatchObject({ code: 'SIGNED_RECEIPT_CONFLICT' });

    expect(existsSync(finalPackagePath)).toBe(false);
    const next = parseJson<{ data: { ci_proof: { status: string; gates: Array<{ status: string }> } } }>(
      (await runCli(fixture.repoDir, ['session', 'next', '--session', fixture.sessionId, '--json'])).stdout,
    );
    expect(next.data.ci_proof).toMatchObject({ status: 'corrupt', gates: [{ status: 'corrupt' }] });
  });

  it('rejects a genuinely verified failing gate without a row or retained final package', async () => {
    const fixture = await makeVerifyingSession();
    const failed = signedArtifact(fixture, {
      receipt_id: 'receipt_signed_failed',
      result: 'failed',
      exit_status: 1,
    });
    const packagePath = await writePackage(fixture, failed);

    await expect(
      importSessionGateReceipt({
        cwd: fixture.repoDir,
        sessionId: fixture.sessionId,
        packagePath,
        verifyReceipt: verifier(fixture, failed),
      }),
    ).rejects.toMatchObject({ code: 'SIGNED_RECEIPT_RESULT_REJECTED' });

    expect(
      existsSync(
        path.join(
          fixture.repoDir,
          '.threadloop/artifacts/receipts',
          fixture.sessionId,
          'receipt_signed_failed',
          'signed-receipt.json',
        ),
      ),
    ).toBe(false);
    const db = new DatabaseSync(path.join(fixture.repoDir, '.threadloop/state/state.db'), { readOnly: true });
    try {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM signed_gate_receipts`).get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it('accepts one winner across concurrent identical imports', async () => {
    const fixture = await makeVerifyingSession();
    const packagePath = await writePackage(fixture, signedArtifact(fixture));

    const results = await Promise.all(
      Array.from({ length: 2 }, () =>
        importSessionGateReceipt({
          cwd: fixture.repoDir,
          sessionId: fixture.sessionId,
          packagePath,
          verifyReceipt: verifier(fixture),
        }),
      ),
    );

    expect(results.map((result) => result.receipt.sequence)).toEqual([1, 1]);
    expect(results.map((result) => result.already_imported).sort()).toEqual([false, true]);
    const db = new DatabaseSync(path.join(fixture.repoDir, '.threadloop/state/state.db'), { readOnly: true });
    try {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM signed_gate_receipts`).get()).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it('rejects a receipt id reused for different verified content', async () => {
    const fixture = await makeVerifyingSession();
    const firstArtifact = signedArtifact(fixture);
    const packagePath = await writePackage(fixture, firstArtifact);
    const first = await importSessionGateReceipt({
      cwd: fixture.repoDir,
      sessionId: fixture.sessionId,
      packagePath,
      verifyReceipt: verifier(fixture, firstArtifact),
    });
    const conflictingArtifact = signedArtifact(fixture, {
      output: { stdout_sha256: 'e'.repeat(64), stderr_sha256: 'f'.repeat(64) },
    });
    await writePackage(fixture, conflictingArtifact);

    await expect(
      importSessionGateReceipt({
        cwd: fixture.repoDir,
        sessionId: fixture.sessionId,
        packagePath,
        verifyReceipt: verifier(fixture, conflictingArtifact),
      }),
    ).rejects.toMatchObject({ code: 'SIGNED_RECEIPT_CONFLICT' });

    expect(sha256(await readFile(path.join(fixture.repoDir, first.receipt.package.path)))).toBe(
      first.receipt.package.sha256,
    );
    const db = new DatabaseSync(path.join(fixture.repoDir, '.threadloop/state/state.db'), { readOnly: true });
    try {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM signed_gate_receipts`).get()).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it.each([
    {
      name: 'another session plan',
      artifact: (): Partial<SignedGateReceiptArtifact> => ({
        plan_sha256: 'e'.repeat(64),
      }),
      code: 'SIGNED_RECEIPT_INVALID',
    },
    {
      name: 'another HEAD',
      artifact: (): Partial<SignedGateReceiptArtifact> => ({
        head_before: 'e'.repeat(40),
        head_after: 'e'.repeat(40),
        source: {
          repository: sourceRepository,
          ref: `refs/heads/${branch}`,
          head_sha: 'e'.repeat(40),
          run_invocation_uri: `${sourceRepository}/actions/runs/123/attempts/1`,
        },
      }),
      code: 'SIGNED_RECEIPT_HEAD_MISMATCH',
    },
    {
      name: 'another source repository',
      artifact: (fixture: Awaited<ReturnType<typeof makeVerifyingSession>>): Partial<SignedGateReceiptArtifact> => ({
        source: {
          repository: 'https://github.com/example/other',
          ref: `refs/heads/${branch}`,
          head_sha: fixture.head,
          run_invocation_uri: 'https://github.com/example/other/actions/runs/123/attempts/1',
        },
      }),
      code: 'SIGNED_RECEIPT_IDENTITY_MISMATCH',
    },
  ])('rejects $name before any persistence', async ({ artifact: override, code }) => {
    const fixture = await makeVerifyingSession();
    const receiptArtifact = signedArtifact(fixture, override(fixture));
    const packagePath = await writePackage(fixture, receiptArtifact);

    await expect(
      importSessionGateReceipt({
        cwd: fixture.repoDir,
        sessionId: fixture.sessionId,
        packagePath,
        verifyReceipt: verifier(fixture, receiptArtifact),
      }),
    ).rejects.toMatchObject({ code });

    const db = new DatabaseSync(path.join(fixture.repoDir, '.threadloop/state/state.db'), { readOnly: true });
    try {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM signed_gate_receipts`).get()).toEqual({ count: 0 });
      expect(db.prepare(`SELECT status, state_version FROM tasks`).get()).toEqual({
        status: 'verifying',
        state_version: 4,
      });
    } finally {
      db.close();
    }
  });

  it('maps transparency failures without leaving accepted state', async () => {
    const fixture = await makeVerifyingSession();
    const packagePath = await writePackage(fixture, signedArtifact(fixture));

    await expect(
      importSessionGateReceipt({
        cwd: fixture.repoDir,
        sessionId: fixture.sessionId,
        packagePath,
        verifyReceipt: () =>
          Promise.reject(
            new SigstoreReceiptVerificationError('transparency_missing', 'Missing Rekor inclusion proof.'),
          ),
      }),
    ).rejects.toMatchObject({ code: 'SIGNED_RECEIPT_TRANSPARENCY_MISSING' });

    const db = new DatabaseSync(path.join(fixture.repoDir, '.threadloop/state/state.db'), { readOnly: true });
    try {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM signed_gate_receipts`).get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it('verifies the DSSE signature before rejecting an artifact digest mismatch', async () => {
    const fixture = await makeVerifyingSession();
    const packagePath = await writePackage(fixture, signedArtifact(fixture));
    const value = JSON.parse(await readFile(packagePath, 'utf8')) as {
      artifact: SignedGateReceiptArtifact;
    };
    value.artifact.output.stdout_sha256 = 'e'.repeat(64);
    await writeFile(packagePath, canonicalJson(value), 'utf8');
    let signatureVerified = false;

    await expect(
      importSessionGateReceipt({
        cwd: fixture.repoDir,
        sessionId: fixture.sessionId,
        packagePath,
        verifyReceipt: () => {
          signatureVerified = true;
          return verifier(fixture)();
        },
      }),
    ).rejects.toMatchObject({ code: 'SIGNED_RECEIPT_ARTIFACT_MISMATCH' });

    expect(signatureVerified).toBe(true);
    const db = new DatabaseSync(path.join(fixture.repoDir, '.threadloop/state/state.db'), { readOnly: true });
    try {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM signed_gate_receipts`).get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it('reports accepted proof as corrupt after package tampering and stale after HEAD advances', async () => {
    const corruptFixture = await makeVerifyingSession();
    const corruptInput = await writePackage(corruptFixture, signedArtifact(corruptFixture));
    const imported = await importSessionGateReceipt({
      cwd: corruptFixture.repoDir,
      sessionId: corruptFixture.sessionId,
      packagePath: corruptInput,
      verifyReceipt: verifier(corruptFixture),
    });
    await writeFile(path.join(corruptFixture.repoDir, imported.receipt.package.path), '{}', 'utf8');
    const corruptNext = parseJson<{ data: { ci_proof: { status: string; gates: Array<{ status: string }> } } }>(
      (await runCli(corruptFixture.repoDir, ['session', 'next', '--session', corruptFixture.sessionId, '--json']))
        .stdout,
    );
    expect(corruptNext.data.ci_proof).toMatchObject({ status: 'corrupt', gates: [{ status: 'corrupt' }] });

    const staleFixture = await makeVerifyingSession();
    const staleInput = await writePackage(staleFixture, signedArtifact(staleFixture));
    await importSessionGateReceipt({
      cwd: staleFixture.repoDir,
      sessionId: staleFixture.sessionId,
      packagePath: staleInput,
      verifyReceipt: verifier(staleFixture),
    });
    await writeFile(path.join(staleFixture.repoDir, 'later.txt'), 'later\n', 'utf8');
    await execFileAsync('git', ['add', 'later.txt'], { cwd: staleFixture.repoDir });
    await execFileAsync('git', ['commit', '-m', 'advance HEAD'], { cwd: staleFixture.repoDir });
    const staleNext = parseJson<{ data: { ci_proof: { status: string; gates: Array<{ status: string }> } } }>(
      (await runCli(staleFixture.repoDir, ['session', 'next', '--session', staleFixture.sessionId, '--json'])).stdout,
    );
    expect(staleNext.data.ci_proof).toMatchObject({ status: 'stale', gates: [{ status: 'stale' }] });
  });
});
