import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const projectRoot = process.cwd();

async function run(command, args, cwd) {
  const { stdout, stderr } = await execFileAsync(command, args, { cwd });
  return { stdout, stderr };
}

async function makeRepo(prefix) {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  await run('git', ['init'], repoDir);
  await run('git', ['config', 'user.email', 'test@example.com'], repoDir);
  await run('git', ['config', 'user.name', 'Test User'], repoDir);
  return repoDir;
}

async function main() {
  const packDir = await mkdtemp(path.join(os.tmpdir(), 'threadloop-smoke-pack-'));
  const consumerRepo = await makeRepo('threadloop-smoke-consumer-');

  try {
    await verifyInstall(packDir, consumerRepo);
  } finally {
    await Promise.all([packDir, consumerRepo].map((directory) => rm(directory, { recursive: true, force: true })));
  }
}

async function verifyInstall(packDir, consumerRepo) {
  console.log(`Packing ThreadLoop from ${projectRoot}`);
  await run('npm', ['pack', '--pack-destination', packDir], projectRoot);

  const packedFiles = await readdir(packDir);
  const tarball = packedFiles.find((file) => file.endsWith('.tgz'));
  if (!tarball) {
    throw new Error('npm pack did not produce a tarball.');
  }

  const tarballPath = path.join(packDir, tarball);
  console.log(`Installing ${tarballPath} into ${consumerRepo}`);
  await run('npm', ['install', tarballPath], consumerRepo);

  // Dependency overrides only apply at the install root. Check the libraries
  // reached from the installed CLI, where its package.json is a dependency.
  const installedRoot = path.join(consumerRepo, 'node_modules', 'threadloop');
  await run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import assert from 'node:assert/strict';
        import { createRequire } from 'node:module';
        const contracts = createRequire(import.meta.resolve('threadloop-contracts/controller'));
        const zod = contracts('zod');
        const result = zod.array(zod.string()).max(1).safeParse(Array.from({ length: 16 }, () => 0));
        assert.equal(result.success, false);
        assert.equal(result.error.issues.length, 1, 'Packaged contracts must stop before expanding oversized collections.');
        const sigstore = createRequire(import.meta.resolve('sigstore'));
        const tuf = createRequire(sigstore.resolve('@sigstore/tuf'));
        const client = createRequire(tuf.resolve('tuf-js'));
        const models = createRequire(client.resolve('@tufjs/models'));
        const { Minimatch } = models('minimatch');
        assert.throws(() => new Minimatch('a/**/../b/c', {
          optimizationLevel: 2, braceExpandMax: 1
        }), /too many patterns/, 'Packaged TUF matching must enforce its pattern budget.');
      `,
    ],
    installedRoot,
  );

  await writeFile(path.join(consumerRepo, 'app.js'), 'export const value = 1;\n', 'utf8');

  const threadloop = (...args) => run('npx', ['threadloop', ...args], consumerRepo);
  const threadloopJson = async (...args) => JSON.parse((await threadloop(...args, '--json')).stdout).data;
  const expect = (condition, message) => {
    if (!condition) {
      throw new Error(message);
    }
  };

  await threadloop('init');
  // A second repository keeps control storage outside the measured subject.
  const subject = await makeRepo('threadloop-smoke-subject-');
  try {
    await writeFile(path.join(subject, 'quote.txt'), 'subtotal=100\n');
    await run('git', ['add', 'quote.txt'], subject);
    await run('git', ['-c', 'commit.gpgsign=false', 'commit', '-m', 'Initialize the shipping quote'], subject);
    await run('git', ['branch', '-M', 'quote'], subject);
    const profile = path.join(projectRoot, 'tests/fixtures/workflow/quote.yaml');
    await writeFile(
      path.join(consumerRepo, 'quote-setup.json'),
      JSON.stringify({
        schema_version: 'threadloop.workflow-setup/1',
        subject_workspace: await realpath(subject),
        repository_id: 'packaged-quote',
        policy: {
          id: 'quote',
          proof_binding_transition_id: null,
          local_gate_ids: [],
          independent_gate_ids: [],
          publication_destination: null,
        },
        proof_plan: null,
        trusted_sources: null,
        allowed_change_paths: [],
      }),
    );
    const created = await threadloopJson(
      'workflow',
      'create',
      'quote',
      '--profile',
      profile,
      '--setup',
      'quote-setup.json',
    );
    expect(
      created.state === 'intake' && created.state_version === 0,
      'The packaged CLI must create the initial graph state.',
    );
    const decided = await threadloop('workflow', 'decide', 'quote', '--json');
    await writeFile(path.join(consumerRepo, 'decision.json'), decided.stdout);
    const apply = await threadloopJson(
      'workflow',
      'apply',
      'quote',
      '--decision',
      'decision.json',
      '--idempotency-key',
      'start',
    );
    const reopened = await threadloopJson('workflow', 'inspect', 'quote');
    expect(
      apply.transition_id === 'start_quote' && reopened.state === 'prepared' && reopened.state_version === 1,
      'The installed CLI must reopen the selected, committed state.',
    );
    const v5 = await threadloopJson('protocol', '--contract', '5');
    expect(
      v5.capabilities.includes('workflow_runs_v1') &&
        v5.capabilities.includes('workflow_gaap_execution_v1') &&
        v5.commands['workflow apply'] &&
        v5.commands['workflow execute'],
      'The installed protocol must advertise workflow runs.',
    );
    const oldStreams = [
      [[], '5ac51f9c27359b9f27e717adec58d4b85c3e78e4b721957ed534f2d9a7e40fcf'],
      [['--json'], 'e5943879bfaf27696f0c791adca0d5510e6e49d5660edfa9beb75931c846ed90'],
    ];
    for (const [flags, hash] of oldStreams) {
      for (const negotiated of [[], ['--contract', '4']]) {
        const out = await threadloop('protocol', ...negotiated, ...flags);
        expect(
          createHash('sha256').update(out.stdout).digest('hex') === hash,
          'The installed v4 protocol output changed.',
        );
      }
    }
    const future = await threadloop('protocol', '--contract', '6', '--json').then(
      () => null,
      (error) => error,
    );
    expect(
      future && JSON.parse(future.stderr).error.code === 'INVALID_ARGUMENT',
      'The installed CLI must reject an unknown protocol version.',
    );
  } finally {
    await rm(subject, { recursive: true, force: true });
  }

  await run(
    process.execPath,
    ['--import', 'tsx', 'scripts/smoke-managed-workflow.ts', path.join(installedRoot, 'dist', 'cli.js')],
    projectRoot,
  );
  const { session_id: sessionId } = await threadloopJson(
    'session',
    'start',
    'Smoke packaged install',
    '--goal',
    'Verify packaged CLI works',
  );
  const captured = await threadloopJson(
    'session',
    'capture',
    'note',
    'Installed from tarball and started session',
    '--session',
    sessionId,
  );
  expect(captured.session_id === sessionId, 'Capture did not target the started session.');

  await threadloop('artifact', 'generate');
  const artifactPath = path.join(consumerRepo, '.threadloop/artifacts/smoke-packaged-install.change-brief.md');
  const artifact = await readFile(artifactPath, 'utf8');
  expect(artifact.includes('app.js'), 'Smoke pack artifact is missing app.js.');
  expect(!artifact.includes('.threadloop/'), 'Smoke pack artifact incorrectly includes ThreadLoop-owned paths.');

  const next = await threadloopJson('session', 'next', '--session', sessionId);
  expect(
    next.candidate?.target_state === 'framed' && next.candidate.executable === true,
    'Session next did not offer framed.',
  );
  const transitioned = await threadloopJson(
    'session',
    'transition',
    'framed',
    '--session',
    sessionId,
    '--expected-state-version',
    '0',
    '--idempotency-key',
    'smoke:framed',
    '--actor',
    'agent',
    '--input',
    '{}',
  );
  expect(
    transitioned.lifecycle.state === 'framed' && transitioned.lifecycle.state_version === 1,
    'Transition to framed did not apply.',
  );

  const status = await threadloop('session', 'status', '--session', sessionId);
  expect(status.stdout.includes('Task: Smoke packaged install'), 'Session status output is missing the task.');
  expect(status.stdout.includes('Status: framed'), 'Session status did not report the framed state.');

  const configuration = async (id) =>
    (await threadloopJson('audit', 'show', '--session', id)).events[0].event.payload.run_configuration;
  const newConfiguration = async () => {
    const result = await threadloopJson('session', 'start', 'Package identity', '--goal', 'Compare installed files');
    return configuration(result.session_id);
  };
  const installed = await configuration(sessionId);
  expect(installed.implementation_scope === 'npm_bundled_files', 'The installed CLI must identify its bundled files.');
  // This nested copy ships with the contracts package. Its entry file and the CLI bundle stay identical.
  const nestedModule = path.join(
    installedRoot,
    'node_modules/threadloop-contracts/node_modules/yaml/dist/compose/compose-node.js',
  );
  const original = await readFile(nestedModule);
  await appendFile(nestedModule, '\n// Smoke fixture change.\n');
  const changed = await newConfiguration();
  expect(
    changed.implementation_scope === installed.implementation_scope &&
      changed.implementation_sha256 !== installed.implementation_sha256,
    'Changed nested package bytes must change the fingerprint.',
  );
  await writeFile(nestedModule, original);
  await writeFile(path.join(consumerRepo, 'app.js'), 'export const value = 2;\n');
  expect(
    (await newConfiguration()).implementation_sha256 === installed.implementation_sha256,
    'Restoring package bytes must restore the fingerprint regardless of consumer files.',
  );
  // An optional bundled package can still resolve from the consumer after npm hoists it.
  await rename(path.join(installedRoot, 'node_modules/iconv-lite'), path.join(consumerRepo, 'node_modules/iconv-lite'));
  expect(
    (await newConfiguration()).implementation_scope === 'javascript_bundle',
    'A hoisted installation must report its narrower scope.',
  );

  console.log('Smoke pack verification passed.');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`threadloop smoke: ${message}`);
  process.exit(1);
});
