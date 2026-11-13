import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { it, expect } from 'vitest';

const execute = promisify(execFile);
it('replays and exports duplicate delivery without leaking expected outcomes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'controller-replay-'));
  try {
    const input = path.join(root, 'history.json');
    const output = path.join(root, 'scenario.json');
    await writeFile(
      input,
      JSON.stringify({
        schema: 'threadloop.generated-history/1',
        retry: 'reconciliation_required',
        steps: [
          { kind: 'acquire', slot: 0, actor: 'a', lease: 5 },
          { kind: 'redeliver', index: 0, changed: false },
          { kind: 'restart' },
        ],
      }),
    );
    const result = await execute('npm', ['run', 'test:controller:replay', '--', input, '--export-conformance', output]);
    expect(result.stdout).toContain('Controller history passed: 3 steps.');
    const exported = JSON.parse(await readFile(output, 'utf8')) as { steps: unknown[] };
    expect(Object.keys(exported).sort()).toEqual(['admitted_digests', 'initial', 'projection_snapshot', 'steps']);
    expect(exported.steps).toHaveLength(2);
    expect(exported.steps[0]).toEqual(exported.steps[1]);
    const overwrite = execute('npm', ['run', 'test:controller:replay', '--', input, '--export-conformance', output]);
    await expect(overwrite).rejects.toMatchObject({ code: 1 });
    await expect(overwrite).rejects.toThrow('History replay failed:');
    expect(JSON.parse(await readFile(output, 'utf8'))).toEqual(exported);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('reports replay usage and rejects unsupported history versions with a failing exit', async () => {
  const help = await execute('npm', ['run', 'test:controller:replay', '--', '--help']);
  expect(help.stdout).toContain('Usage: npm run test:controller:replay');
  const root = await mkdtemp(path.join(tmpdir(), 'controller-invalid-replay-'));
  try {
    const input = path.join(root, 'history.json');
    await writeFile(input, JSON.stringify({ schema: 'unknown', steps: [] }));
    const invalid = execute('npm', ['run', 'test:controller:replay', '--', input]);
    await expect(invalid).rejects.toMatchObject({ code: 1 });
    await expect(invalid).rejects.toThrow('Unsupported history schema');
    await writeFile(input, JSON.stringify({ schema: 'threadloop.generated-history/1', retry: 'invented', steps: [] }));
    const invalidController = execute('npm', ['run', 'test:controller:replay', '--', input]);
    await expect(invalidController).rejects.toMatchObject({ code: 1 });
    await expect(invalidController).rejects.toThrow('retry');
    await expect(invalidController).rejects.not.toThrow('generated-process-history');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
