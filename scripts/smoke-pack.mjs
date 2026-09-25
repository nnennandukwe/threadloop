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
