import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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

  console.log('Smoke pack verification passed.');
  await Promise.all([packDir, consumerRepo].map((directory) => rm(directory, { recursive: true, force: true })));
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`threadloop smoke: ${message}`);
  process.exit(1);
});
