import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runGateProcess } from '../../src/adapters/process/gate-runner.js';

const temporaryDirectories: string[] = [];

async function makeDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'threadloop-gate-runner-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('gate process runner', () => {
  it('records an explicit abort only after the child closes', async () => {
    const directory = await makeDirectory();
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 50).unref();

    const result = await runGateProcess({
      command: ['node', '-e', 'setInterval(() => {}, 1000)'],
      cwd: directory,
      timeoutMs: 5_000,
      stdoutPath: path.join(directory, 'stdout.log'),
      stderrPath: path.join(directory, 'stderr.log'),
      abortSignal: abort.signal,
    });

    expect(result).toMatchObject({
      result: 'aborted',
      exitStatus: null,
      signal: 'SIGTERM',
    });
    expect(Date.parse(result.endedAt)).toBeGreaterThanOrEqual(Date.parse(result.startedAt));
  });

  it('records cleanup_failed when an output artifact cannot be exclusively created', async () => {
    const directory = await makeDirectory();
    const stdoutPath = path.join(directory, 'stdout.log');
    await writeFile(stdoutPath, 'already exists\n', 'utf8');

    const result = await runGateProcess({
      command: ['node', '-e', 'process.stdout.write("output")'],
      cwd: directory,
      timeoutMs: 5_000,
      stdoutPath,
      stderrPath: path.join(directory, 'stderr.log'),
    });

    expect(result.result).toBe('cleanup_failed');
    expect(result.error?.code).toBe('EEXIST');
  });

  it('uses an explicit environment without leaking parent OIDC or control paths', async () => {
    const directory = await makeDirectory();
    const sensitiveNames = ['ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL', 'THREADLOOP_REPORT_PATH'];
    const priorValues = new Map(sensitiveNames.map((name) => [name, process.env[name]]));
    for (const name of sensitiveNames) {
      process.env[name] = `parent-${name}`;
    }
    const gateEnvironment: NodeJS.ProcessEnv = { ...process.env, THREADLOOP_GATE_VISIBLE: 'allowed' };
    for (const name of sensitiveNames) {
      delete gateEnvironment[name];
    }

    try {
      const result = await runGateProcess({
        command: [
          'node',
          '-e',
          `
            const blocked = ${JSON.stringify(sensitiveNames)};
            const leaked = blocked.some((name) => process.env[name]);
            process.exit(!leaked && process.env.THREADLOOP_GATE_VISIBLE === 'allowed' ? 0 : 9);
          `,
        ],
        cwd: directory,
        timeoutMs: 5_000,
        stdoutPath: path.join(directory, 'stdout.log'),
        stderrPath: path.join(directory, 'stderr.log'),
        env: gateEnvironment,
      });

      expect(result.result).toBe('passed');
      expect(result.exitStatus).toBe(0);
    } finally {
      for (const [name, value] of priorValues) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }
  });
});
