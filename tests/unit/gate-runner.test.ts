import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyGateOutcome,
  gateExecutionWasInvalidated,
  runGateProcess,
  runGateWithSetup,
  type GateRepositoryObservation,
  type GateSetupStepInput,
} from '../../src/adapters/process/gate-runner.js';

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

describe('gate runner with declared setup', () => {
  const head = 'd'.repeat(40);

  function stepInput(directory: string, id: string, command: string[]): GateSetupStepInput {
    return {
      id,
      command,
      workingDirectory: '.',
      cwd: directory,
      timeoutMs: 5_000,
      stdoutPath: path.join(directory, `${id}.stdout.log`),
      stderrPath: path.join(directory, `${id}.stderr.log`),
    };
  }

  function stableObserver(): { observe: () => Promise<GateRepositoryObservation>; calls: () => number } {
    let calls = 0;
    return {
      observe: () => {
        calls += 1;
        return Promise.resolve({ headSha: head, clean: true });
      },
      calls: () => calls,
    };
  }

  it('runs declared setup steps in order before the gate command', async () => {
    const directory = await makeDirectory();
    const orderPath = path.join(directory, 'order.txt');
    const append = (label: string) => `require("node:fs").appendFileSync(${JSON.stringify(orderPath)}, "${label}\\n")`;
    const observer = stableObserver();

    const result = await runGateWithSetup({
      setup: [
        stepInput(directory, 'first', ['node', '-e', append('first')]),
        stepInput(directory, 'second', ['node', '-e', append('second')]),
      ],
      gate: {
        command: ['node', '-e', append('gate')],
        cwd: directory,
        timeoutMs: 5_000,
        stdoutPath: path.join(directory, 'gate.stdout.log'),
        stderrPath: path.join(directory, 'gate.stderr.log'),
      },
      observedBefore: { headSha: head, clean: true },
      observe: observer.observe,
    });

    expect(await readFile(orderPath, 'utf8')).toBe('first\nsecond\ngate\n');
    expect(result.setup.map((step) => step.id)).toEqual(['first', 'second']);
    expect(result.setup.every((step) => step.process.result === 'passed')).toBe(true);
    expect(result.gate?.result).toBe('passed');
    // One observation after each setup step, plus one after the gate.
    expect(observer.calls()).toBe(3);
  });

  it('stops the sequence at a failing setup step so the gate command never runs', async () => {
    const directory = await makeDirectory();
    const markerPath = path.join(directory, 'gate-ran.txt');
    const observer = stableObserver();

    const result = await runGateWithSetup({
      setup: [
        stepInput(directory, 'broken', ['node', '-e', 'process.exit(3)']),
        stepInput(directory, 'unreached', ['node', '-e', 'process.exit(0)']),
      ],
      gate: {
        command: ['node', '-e', `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "ran")`],
        cwd: directory,
        timeoutMs: 5_000,
        stdoutPath: path.join(directory, 'gate.stdout.log'),
        stderrPath: path.join(directory, 'gate.stderr.log'),
      },
      observedBefore: { headSha: head, clean: true },
      observe: observer.observe,
    });

    expect(result.setup.map((step) => step.id)).toEqual(['broken']);
    expect(result.setup[0]?.process).toMatchObject({ result: 'failed', exitStatus: 3 });
    expect(result.gate).toBeNull();
    await expect(readFile(markerPath, 'utf8')).rejects.toThrow();
  });

  it('stops the sequence when a setup step leaves the repository dirty', async () => {
    const directory = await makeDirectory();
    const observer = {
      observe: () => Promise.resolve({ headSha: head, clean: false }),
    };

    const result = await runGateWithSetup({
      setup: [
        stepInput(directory, 'dirties', ['node', '-e', 'process.exit(0)']),
        stepInput(directory, 'unreached', ['node', '-e', 'process.exit(0)']),
      ],
      gate: {
        command: ['node', '-e', 'process.exit(0)'],
        cwd: directory,
        timeoutMs: 5_000,
        stdoutPath: path.join(directory, 'gate.stdout.log'),
        stderrPath: path.join(directory, 'gate.stderr.log'),
      },
      observedBefore: { headSha: head, clean: true },
      observe: observer.observe,
    });

    expect(result.setup.map((step) => step.id)).toEqual(['dirties']);
    expect(result.setup[0]).toMatchObject({ cleanBefore: true, cleanAfter: false });
    expect(result.gate).toBeNull();
  });

  it('keeps a failed mid-run observation invalidated when a later observation succeeds', async () => {
    const directory = await makeDirectory();
    const observedBefore = { headSha: head, clean: true };

    const result = await runGateWithSetup({
      setup: [stepInput(directory, 'sync', ['node', '-e', 'process.exit(0)'])],
      gate: {
        command: ['node', '-e', 'process.exit(0)'],
        cwd: directory,
        timeoutMs: 5_000,
        stdoutPath: path.join(directory, 'gate.stdout.log'),
        stderrPath: path.join(directory, 'gate.stderr.log'),
      },
      observedBefore,
      observe: () => Promise.resolve(null),
    });

    expect(result.setup[0]).toMatchObject({ headAfter: head, cleanAfter: false });
    expect(result.gate).toBeNull();
    expect(result.observedAfter).toBeNull();

    const finalObservation = { headSha: head, clean: true };
    const invalidated =
      gateExecutionWasInvalidated(result, observedBefore) ||
      !finalObservation.clean ||
      finalObservation.headSha !== observedBefore.headSha;

    expect(classifyGateOutcome({ setup: result.setup, gate: result.gate, invalidated })).toBe('invalidated');
  });

  it('runs the gate directly when no setup is declared', async () => {
    const directory = await makeDirectory();
    const observer = stableObserver();

    const result = await runGateWithSetup({
      setup: [],
      gate: {
        command: ['node', '-e', 'process.exit(0)'],
        cwd: directory,
        timeoutMs: 5_000,
        stdoutPath: path.join(directory, 'gate.stdout.log'),
        stderrPath: path.join(directory, 'gate.stderr.log'),
      },
      observedBefore: { headSha: head, clean: true },
      observe: observer.observe,
    });

    expect(result.setup).toEqual([]);
    expect(result.gate?.result).toBe('passed');
    expect(observer.calls()).toBe(1);
  });
});
