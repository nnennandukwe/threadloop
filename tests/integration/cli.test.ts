import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const projectRoot = process.cwd();
const tsxCli = path.join(projectRoot, 'node_modules/tsx/dist/cli.mjs');
const cliEntry = path.join(projectRoot, 'src/cli.ts');

async function runCli(cwd: string, args: string[], env?: NodeJS.ProcessEnv) {
  return execFileAsync('node', [tsxCli, cliEntry, ...args], { cwd, env: env ? { ...process.env, ...env } : process.env });
}

async function readArtifact(repoDir: string, name: string) {
  return readFile(path.join(repoDir, `.threadloop/artifacts/${name}`), 'utf8');
}

describe('threadloop CLI', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(path.join(os.tmpdir(), 'threadloop-'));
    await execFileAsync('git', ['init'], { cwd: repoDir });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
    await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
  });

  it('initializes, starts, captures, generates an artifact, and finishes', async () => {
    await runCli(repoDir, ['init']);
    await runCli(repoDir, ['start', 'Add retry logic', '--goal', 'Reduce transient failures']);
    await runCli(repoDir, ['capture', 'decision', 'Retry only idempotent jobs', '--because', 'Non-idempotent replay is unsafe']);
    await runCli(repoDir, ['artifact', 'generate']);
    await runCli(repoDir, ['finish']);

    const artifact = await readArtifact(repoDir, 'add-retry-logic.change-brief.md');
    expect(artifact).toContain('# Add retry logic');
    expect(artifact).toContain('Retry only idempotent jobs');

    const stateRaw = await readFile(path.join(repoDir, '.threadloop/state/state.json'), 'utf8');
    expect(stateRaw).toContain('completed');
    expect(stateRaw).toContain('decision');
  });

  it('supports capture via $EDITOR and alternate artifact renderers', async () => {
    const editorScript = path.join(repoDir, 'fake-editor.sh');
    await writeFile(editorScript, '#!/bin/sh\nprintf "Reviewer should inspect retry cancellation path" > "$1"\n', 'utf8');
    await execFileAsync('chmod', ['+x', editorScript], { cwd: repoDir });

    await runCli(repoDir, ['init']);
    await runCli(repoDir, ['start', 'Add retry logic', '--goal', 'Reduce transient failures']);
    await runCli(repoDir, ['capture', 'reviewer_guidance', '--edit'], { EDITOR: `sh ${editorScript}` });
    await runCli(repoDir, ['artifact', 'generate', 'pr-summary']);
    await runCli(repoDir, ['artifact', 'generate', 'handoff']);

    const prSummary = await readArtifact(repoDir, 'add-retry-logic.pr-summary.md');
    const handoff = await readArtifact(repoDir, 'add-retry-logic.handoff.md');

    expect(prSummary).toContain('# PR Summary: Add retry logic');
    expect(prSummary).toContain('Reviewer should inspect retry cancellation path');
    expect(handoff).toContain('# Handoff: Add retry logic');
  });

  it('creates .gitignore on init when missing', async () => {
    const result = await runCli(repoDir, ['init']);
    const gitignore = await readFile(path.join(repoDir, '.gitignore'), 'utf8');

    expect(result.stdout).toContain('Initialized ThreadLoop');
    expect(result.stdout).toContain('Created .gitignore and added .threadloop/state/');
    expect(gitignore).toBe('.threadloop/state/\n');
  });

  it('updates existing .gitignore without duplicating the state entry', async () => {
    await writeFile(path.join(repoDir, '.gitignore'), 'node_modules/\n', 'utf8');

    const first = await runCli(repoDir, ['init']);
    const second = await runCli(repoDir, ['init']);
    const gitignore = await readFile(path.join(repoDir, '.gitignore'), 'utf8');

    expect(first.stdout).toContain('Updated .gitignore to ignore .threadloop/state/');
    expect(second.stdout).toContain('.gitignore already ignores .threadloop/state/');
    expect(gitignore.match(/\.threadloop\/state\//g)?.length).toBe(1);
  });

  it('leaves .gitignore unchanged when a broader ignore already covers ThreadLoop state', async () => {
    await writeFile(path.join(repoDir, '.gitignore'), '.threadloop/\n', 'utf8');

    const result = await runCli(repoDir, ['init']);
    const gitignore = await readFile(path.join(repoDir, '.gitignore'), 'utf8');

    expect(result.stdout).toContain('.gitignore already ignores .threadloop/state/');
    expect(gitignore).toBe('.threadloop/\n');
  });

  it('filters ThreadLoop-owned paths from artifact scope without a base ref', async () => {
    await runCli(repoDir, ['init']);
    await writeFile(path.join(repoDir, 'feature.ts'), 'export const feature = true;\n', 'utf8');
    await runCli(repoDir, ['start', 'Track feature work', '--goal', 'Keep scope clean']);
    await runCli(repoDir, ['capture', 'note', 'Only repo files should appear in scope']);
    await runCli(repoDir, ['artifact', 'generate']);

    const artifact = await readArtifact(repoDir, 'track-feature-work.change-brief.md');
    expect(artifact).toContain('feature.ts');
    expect(artifact).not.toContain('.threadloop/config.json');
    expect(artifact).not.toContain('.threadloop/state/state.json');
    expect(artifact).not.toContain('.threadloop/artifacts/');
  });

  it('filters ThreadLoop-owned paths from artifact scope with a base ref', async () => {
    await writeFile(path.join(repoDir, 'base.txt'), 'base\n', 'utf8');
    await execFileAsync('git', ['add', 'base.txt'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'base commit'], { cwd: repoDir });
    await execFileAsync('git', ['branch', '-M', 'main'], { cwd: repoDir });
    await execFileAsync('git', ['checkout', '-b', 'feature/threadloop'], { cwd: repoDir });

    await runCli(repoDir, ['init']);
    await writeFile(path.join(repoDir, 'feature.ts'), 'export const feature = 2;\n', 'utf8');
    await execFileAsync('git', ['add', 'feature.ts'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'feature commit'], { cwd: repoDir });

    await runCli(repoDir, ['start', 'Base-aware scope', '--goal', 'Filter internal paths', '--base', 'main']);
    await runCli(repoDir, ['artifact', 'generate']);

    const artifact = await readArtifact(repoDir, 'base-aware-scope.change-brief.md');
    expect(artifact).toContain('feature.ts');
    expect(artifact).not.toContain('.threadloop/');
  });

  it('fails cleanly for a missing base ref', async () => {
    await runCli(repoDir, ['init']);
    await expect(runCli(repoDir, ['start', 'Add retry logic', '--goal', 'Reduce transient failures', '--base', 'missing-branch'])).rejects.toThrow();
  });

  it('fails cleanly outside a git repository', async () => {
    const nonRepoDir = await mkdtemp(path.join(os.tmpdir(), 'threadloop-no-git-'));
    await expect(runCli(nonRepoDir, ['init'])).rejects.toThrow();
  });
});
