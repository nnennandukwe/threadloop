import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { controllerFixture } from '../fixtures/gaap-controller.js';
import { observeGaapWorkspace, readGaapFile, requireGaapDirectory } from '../../src/adapters/fs/gaap-files.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it('reports a clean committed repository with nested folders as clean', async () => {
  const fixture = await controllerFixture();
  roots.push(fixture.root);
  await mkdir(path.join(fixture.workspace, 'nested'));
  await writeFile(path.join(fixture.workspace, 'nested', 'file.txt'), 'tracked nested content');
  execFileSync('git', ['-C', fixture.workspace, 'add', 'nested/file.txt']);
  execFileSync('git', [
    '-C',
    fixture.workspace,
    '-c',
    'user.name=ThreadLoop Test',
    '-c',
    'user.email=test@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'nested fixture',
  ]);
  expect(observeGaapWorkspace(fixture.workspace).clean).toBe(true);
});
it("doesn't report a clean repository when the index differs from both HEAD and restored working bytes", async () => {
  const fixture = await controllerFixture();
  roots.push(fixture.root);
  const filename = path.join(fixture.workspace, 'source.txt');
  const original = await readFile(filename);
  await writeFile(filename, 'staged content');
  execFileSync('git', ['-C', fixture.workspace, 'add', 'source.txt']);
  await writeFile(filename, original);
  expect(observeGaapWorkspace(fixture.workspace).clean).toBe(false);
});
it('observes a bounded physical workspace when deleted tracked entries exceed 64 KiB', async () => {
  const fixture = await controllerFixture();
  roots.push(fixture.root);
  const git = (...args: string[]) => ['-C', fixture.workspace, ...args];
  const blob = execFileSync('git', git('hash-object', '-w', '--stdin'), {
    input: 'historical tracked content',
    encoding: 'utf8',
  }).trim();
  const entries = Array.from(
    { length: 1200 },
    (_, index) => `100644 ${blob}\tdeleted-${index.toString().padStart(8, '0')}.txt\n`,
  ).join('');
  execFileSync('git', git('update-index', '--index-info'), { input: entries });
  execFileSync(
    'git',
    git(
      '-c',
      'user.name=ThreadLoop Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'tracked entries absent from the current workspace',
    ),
  );
  const listing = execFileSync('git', git('ls-tree', '-rz', '--full-tree', 'HEAD'));
  expect(listing.length).toBeGreaterThan(64 * 1024);
  const observed = observeGaapWorkspace(fixture.workspace);
  expect(observed.clean).toBe(false);
  expect(Object.keys(observed.manifest)).toEqual(['.', 'source.txt']);
});
it('observes committed bytes without executing repository-configured fsmonitor or filters', async () => {
  const fixture = await controllerFixture();
  roots.push(fixture.root);
  const marker = path.join(fixture.root, 'unexpected-command');
  const command = 'touch ' + marker;
  execFileSync('git', ['-C', fixture.workspace, 'config', 'core.fsmonitor', command]);
  execFileSync('git', ['-C', fixture.workspace, 'config', 'filter.fixture.clean', command]);
  await writeFile(path.join(fixture.workspace, '.gitattributes'), '*.txt filter=fixture\n');
  const observed = observeGaapWorkspace(fixture.workspace);
  expect(observed.clean).toBe(false);
  await expect(lstat(marker)).rejects.toThrow();
});
it('rejects symlink evidence, symlink directory components and oversized workspace files', async () => {
  const fixture = await controllerFixture();
  roots.push(fixture.root);
  const linked = path.join(fixture.root, 'linked');
  await symlink(fixture.workspace, linked);
  expect(() => requireGaapDirectory(linked)).toThrow('symlink');
  expect(() => readGaapFile(path.join(linked, 'source.txt'), 8192)).toThrow('symlink');
  const evidence = path.join(fixture.root, 'evidence');
  await symlink(path.join(fixture.workspace, 'source.txt'), evidence);
  expect(() => readGaapFile(evidence, 8192)).toThrow();
  await writeFile(path.join(fixture.workspace, 'source.txt'), 'x'.repeat(8193));
  expect(() => observeGaapWorkspace(fixture.workspace)).toThrow('bounded');
  expect((await readFile(path.join(fixture.workspace, 'source.txt'))).length).toBe(8193);
});
