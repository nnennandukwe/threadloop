import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const projectRoot = process.cwd();

async function makeRepo() {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), 'threadloop-pack-'));
  await execFileAsync('git', ['init'], { cwd: repoDir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
  return repoDir;
}

describe('threadloop packaged install', () => {
  it(
    'packs, installs into another repo, and runs end-to-end without including .threadloop paths in artifacts',
    async () => {
      const packDir = await mkdtemp(path.join(os.tmpdir(), 'threadloop-pack-src-'));
      const consumerRepo = await makeRepo();

      await execFileAsync('npm', ['pack', '--pack-destination', packDir], { cwd: projectRoot });
      const packedFiles = await readdir(packDir);
      const tarball = packedFiles.find((file) => file.endsWith('.tgz'));
      expect(tarball).toBeTruthy();

      await execFileAsync('npm', ['install', path.join(packDir, tarball!)], { cwd: consumerRepo });
      await writeFile(path.join(consumerRepo, 'app.js'), 'export const value = 1;\n', 'utf8');

      await execFileAsync('npx', ['threadloop', 'init'], { cwd: consumerRepo });
      await execFileAsync('npx', ['threadloop', 'start', 'Try packaged install', '--goal', 'Verify packaged CLI works'], {
        cwd: consumerRepo,
      });
      await execFileAsync('npx', ['threadloop', 'capture', 'note', 'Installed from tarball and started session'], {
        cwd: consumerRepo,
      });
      await execFileAsync('npx', ['threadloop', 'artifact', 'generate'], { cwd: consumerRepo });
      const status = await execFileAsync('npx', ['threadloop', 'status'], { cwd: consumerRepo });

      expect(status.stdout).toContain('Task: Try packaged install');

      const artifactPath = path.join(consumerRepo, '.threadloop/artifacts/try-packaged-install.change-brief.md');
      const artifact = await readFile(artifactPath, 'utf8');
      expect(artifact).toContain('app.js');
      expect(artifact).not.toContain('.threadloop/');
      expect(artifact).toContain('changed_files:');

      await execFileAsync('npx', ['threadloop', 'finish'], { cwd: consumerRepo });

      const started = JSON.parse(
        (
          await execFileAsync(
            'npx',
            ['threadloop', 'session', 'start', 'Packaged namespace', '--goal', 'Verify namespaced session CLI', '--json'],
            { cwd: consumerRepo },
          )
        ).stdout,
      ) as { data: { session_id: string } };

      const captured = JSON.parse(
        (
          await execFileAsync(
            'npx',
            [
              'threadloop',
              'session',
              'capture',
              'note',
              'Explicit packaged flow works',
              '--session',
              started.data.session_id,
              '--json',
            ],
            { cwd: consumerRepo },
          )
        ).stdout,
      ) as { data: { session_id: string; entry: { body: string } } };
      expect(captured.data.session_id).toBe(started.data.session_id);
      expect(captured.data.entry.body).toBe('Explicit packaged flow works');

      const sessionStatus = JSON.parse(
        (
          await execFileAsync(
            'npx',
            ['threadloop', 'session', 'status', '--session', started.data.session_id, '--json'],
            { cwd: consumerRepo },
          )
        ).stdout,
      ) as { data: { session_id: string; entries: { count: number; kinds: Record<string, number> } } };
      expect(sessionStatus.data.session_id).toBe(started.data.session_id);
      expect(sessionStatus.data.entries.count).toBe(2);
      expect(sessionStatus.data.entries.kinds.note).toBe(1);
    },
    30_000,
  );
});
