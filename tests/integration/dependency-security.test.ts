import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const sigstoreRequire = createRequire(import.meta.resolve('sigstore'));
const tufRequire = createRequire(sigstoreRequire.resolve('@sigstore/tuf'));
const tufClientRequire = createRequire(tufRequire.resolve('tuf-js'));
const modelsRequire = createRequire(tufClientRequire.resolve('@tufjs/models'));
const typescriptEslintRequire = createRequire(import.meta.resolve('typescript-eslint'));
const parserRequire = createRequire(typescriptEslintRequire.resolve('@typescript-eslint/parser'));
const estreeRequire = createRequire(parserRequire.resolve('@typescript-eslint/typescript-estree'));
const markdownRequire = createRequire(import.meta.resolve('markdownlint-cli/package.json'));
const contractsRequire = createRequire(import.meta.resolve('threadloop-contracts/controller'));

interface GlobModule {
  Minimatch: new (pattern: string, options: { optimizationLevel: number; braceExpandMax: number }) => unknown;
}

describe('dependency security and caller compatibility', () => {
  for (const [caller, callerRequire] of [
    ['TUF delegation', modelsRequire],
    ['TypeScript project service', estreeRequire],
    ['Markdown file selection', markdownRequire],
  ] as const) {
    it(`${caller} resolves a matcher that bounds pattern amplification`, () => {
      const { Minimatch } = callerRequire('minimatch') as GlobModule;
      expect(() => new Minimatch('a/**/../b/c', { optimizationLevel: 2, braceExpandMax: 1 })).toThrow(
        /too many patterns/,
      );
    });
  }

  it('the contracts validator stops at an oversized collection before validating its elements', () => {
    const zod = contractsRequire('zod') as typeof import('zod');
    const result = zod
      .array(zod.string())
      .max(1)
      .safeParse(Array.from({ length: 16 }, () => 0));
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the oversized collection to fail validation.');
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues[0]?.code).toBe('too_big');
  });

  it('TUF delegation preserves the allowed path boundary', () => {
    const models = tufClientRequire('@tufjs/models') as {
      Targets: {
        fromJSON(value: unknown): { delegations?: { rolesForTarget(target: string): Iterable<{ role: string }> } };
      };
    };
    const targets = models.Targets.fromJSON({
      _type: 'targets',
      version: 1,
      spec_version: '1.0.31',
      expires: '2030-01-01T00:00:00Z',
      targets: {},
      delegations: {
        keys: {},
        roles: [
          {
            name: 'trusted-targets',
            keyids: ['trusted-key'],
            threshold: 1,
            terminating: false,
            paths: ['targets/*.json', 'metadata/[a-c].json'],
          },
        ],
      },
    });
    const delegations = targets.delegations;
    if (!delegations) throw new Error('Expected the delegations to be retained.');
    for (const target of ['targets/release.json', 'metadata/a.json', 'metadata/c.json']) {
      expect([...delegations.rolesForTarget(target)].map((entry) => entry.role)).toEqual(['trusted-targets']);
    }
    for (const target of [
      'targets/.hidden.json',
      'targets/nested/release.json',
      'targets/../root.json',
      'metadata/d.json',
    ]) {
      expect([...delegations.rolesForTarget(target)]).toEqual([]);
    }
  });

  it('the Markdown CLI excludes ignored globs while still rejecting an unignored invalid file', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'threadloop-markdown-security-')));
    try {
      const config = path.join(root, 'config.json');
      await writeFile(config, JSON.stringify({ default: false, MD041: true }));
      await writeFile(path.join(root, 'valid.md'), '# Valid\n');
      await writeFile(path.join(root, 'ignored.md'), 'Missing the heading.\n');
      const cli = markdownRequire.resolve('./markdownlint.js');
      const args = [cli, '--config', config, root];
      await expect(
        execFileAsync(process.execPath, [...args, '--ignore', path.join(root, '**', 'ignored.md')], { cwd: root }),
      ).resolves.toBeDefined();
      await expect(execFileAsync(process.execPath, args, { cwd: root })).rejects.toMatchObject({ code: 1 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('the TypeScript project service admits only files matched by its default-project allowlist', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'threadloop-estree-security-')));
    try {
      await mkdir(path.join(root, 'src'));
      await mkdir(path.join(root, 'tools'));
      await mkdir(path.join(root, 'private'));
      await writeFile(
        path.join(root, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { allowJs: true }, include: ['src'] }),
      );
      await writeFile(path.join(root, 'src', 'index.ts'), 'export const value = 1;\n');
      await writeFile(path.join(root, 'tools', '.settings.js'), 'export const value = 1;\n');
      await writeFile(path.join(root, 'private', 'blocked.js'), 'export const value = 1;\n');
      const script = `
        import assert from 'node:assert/strict';
        import path from 'node:path';
        const { parser } = await import(${JSON.stringify(import.meta.resolve('typescript-eslint'))});
        const root = ${JSON.stringify(root)};
        const options = { tsconfigRootDir: root, projectService: { allowDefaultProject: ['tools/*.js'] } };
        parser.parseForESLint('export const value = 1;', { ...options, filePath: path.join(root, 'tools/.settings.js') });
        assert.throws(() => parser.parseForESLint('export const value = 1;', {
          ...options, filePath: path.join(root, 'private/blocked.js')
        }), /not found by the project service|not included/);
      `;
      await execFileAsync(process.execPath, ['--input-type=module', '--eval', script], { timeout: 10_000 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
