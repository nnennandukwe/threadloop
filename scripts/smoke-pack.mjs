import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
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

  await run('npx', ['threadloop', 'init'], consumerRepo);
  await run(
    'npx',
    ['threadloop', 'start', 'Smoke packaged install', '--goal', 'Verify packaged CLI works'],
    consumerRepo,
  );
  await run('npx', ['threadloop', 'capture', 'note', 'Installed from tarball and started session'], consumerRepo);
  await run('npx', ['threadloop', 'artifact', 'generate'], consumerRepo);
  const status = await run('npx', ['threadloop', 'status'], consumerRepo);

  const artifactPath = path.join(consumerRepo, '.threadloop/artifacts/smoke-packaged-install.change-brief.md');
  const artifact = await readFile(artifactPath, 'utf8');

  if (!status.stdout.includes('Task: Smoke packaged install')) {
    throw new Error('Smoke pack run did not produce the expected status output.');
  }

  if (!artifact.includes('app.js')) {
    throw new Error('Smoke pack artifact is missing app.js.');
  }

  if (artifact.includes('.threadloop/')) {
    throw new Error('Smoke pack artifact incorrectly includes ThreadLoop-owned paths.');
  }

  console.log('Smoke pack verification passed.');
  console.log(`Artifact: ${artifactPath}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`threadloop smoke: ${message}`);
  process.exit(1);
});
