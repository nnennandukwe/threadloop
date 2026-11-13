import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalExecutorJson, type ExecutorRequest } from 'threadloop-contracts/executor';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import { runGaapProcess } from '../../src/adapters/process/gaap-runner.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(body: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'threadloop-gaap-process-'));
  roots.push(root);
  const script = path.join(root, 'adapter.mjs');
  await writeFile(script, body);
  const asset = import.meta.resolve('threadloop-contracts/assets/executor-v0.1/fixtures/executor-request.canonical');
  const request = JSON.parse(await readFile(new URL(asset), 'utf8')) as ExecutorRequest;
  return {
    root,
    input: { executable: process.execPath, arguments: [script], cwd: root, environment: {}, request, timeoutMs: 3000 },
  };
}

describe('one-shot canonical GAAP process transport', () => {
  it('sends the exact accepted request once followed by EOF and captures complete output', async () => {
    const f = await fixture(
      "let input='';for await(const chunk of process.stdin) input+=chunk;process.stdout.write(input);process.stderr.write('diagnostic');",
    );
    const result = await runGaapProcess(f.input);
    const canonical = canonicalExecutorJson(f.input.request);
    expect(canonical.ok && result.stdout.toString()).toBe(canonical.ok && canonical.value);
    expect(result).toMatchObject({ status: 'ok', exitCode: 0, inputDelivered: true });
    expect(result.stderr.toString()).toBe('diagnostic');
  });
  it('passes shell metacharacters as literal arguments', async () => {
    const f = await fixture('for await(const chunk of process.stdin){} process.stdout.write(process.argv[2]);');
    f.input.arguments.push('; touch SHOULD_NOT_EXIST');
    const result = await runGaapProcess(f.input);
    expect(result.status).toBe('ok');
    expect(result.stdout.toString()).toBe('; touch SHOULD_NOT_EXIST');
    await expect(readFile(path.join(f.root, 'SHOULD_NOT_EXIST'))).rejects.toThrow();
  });
  it('retains output from a failed exit without calling it a successful result', async () => {
    const f = await fixture("for await(const chunk of process.stdin){} process.stdout.write('{}');process.exitCode=7;");
    expect(await runGaapProcess(f.input)).toMatchObject({
      status: 'exit_failed',
      exitCode: 7,
      stdout: Buffer.from('{}'),
    });
  });
  it.each(['stdout', 'stderr'] as const)('bounds excessive %s even when the producer exits zero', async (stream) => {
    const amount = stream === 'stdout' ? 17 * 1024 * 1024 : 65 * 1024;
    const f = await fixture(
      `for await(const chunk of process.stdin){} process.${stream}.write(Buffer.alloc(${amount},120));`,
    );
    const result = await runGaapProcess(f.input);
    expect(result.status).toBe('output_limit');
    expect(result[stream].length).toBeLessThanOrEqual(stream === 'stdout' ? 16 * 1024 * 1024 + 1 : 64 * 1024);
  });
  it('stops a hung producer at the absolute transport deadline', async () => {
    const f = await fixture('setInterval(()=>{},100);');
    f.input.timeoutMs = 40;
    expect(await runGaapProcess(f.input)).toMatchObject({ status: 'timeout' });
  });
  it('cancels before spawn and while the producer is running', async () => {
    const f = await fixture(
      "import {writeFileSync} from 'node:fs';writeFileSync('launched','yes');setInterval(()=>{},100);",
    );
    const before = AbortSignal.abort();
    expect((await runGaapProcess({ ...f.input, abortSignal: before })).status).toBe('cancelled');
    await expect(readFile(path.join(f.root, 'launched'))).rejects.toThrow();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 40);
    try {
      expect((await runGaapProcess({ ...f.input, abortSignal: controller.signal })).status).toBe('cancelled');
    } finally {
      clearTimeout(timer);
    }
  });
  it('rejects an early zero exit when the full request cannot be delivered', async () => {
    const f = await fixture('process.exit(0);');
    f.input.request.request.parameters.task.instructions = 'x'.repeat(1024 * 1024);
    const encoded = canonicalExecutorJson(f.input.request.request);
    if (!encoded.ok) throw new Error('Invalid test request.');
    f.input.request.request_digest = sha256(encoded.value);
    const result = await runGaapProcess(f.input);
    expect(result.status).toBe('input_failed');
    expect(result.inputDelivered).toBe(false);
  });

  it('reports a failed spawn without losing the bounded diagnostic', async () => {
    const f = await fixture('');
    f.input.executable = path.join(f.root, 'missing');
    const result = await runGaapProcess(f.input);
    expect(result.status).toBe('spawn_failed');
    expect(result.error).toContain('ENOENT');
  });
  it('retains synchronous invalid-launch failures as transport observations', async () => {
    const f = await fixture('');
    f.input.arguments.push('invalid\0argument');
    const result = await runGaapProcess(f.input);
    expect(result.status).toBe('spawn_failed');
    expect(result.inputDelivered).toBe(false);
    expect(result.error).toContain('null');
  });
  it('preserves cancellation when an asynchronous spawn failure races it', async () => {
    const f = await fixture('');
    f.input.executable = path.join(f.root, 'missing');
    const controller = new AbortController();
    const execution = runGaapProcess({ ...f.input, abortSignal: controller.signal });
    controller.abort();
    expect((await execution).status).toBe('cancelled');
  });
  it('stops descendants after their leader exits even if they inherit output pipes', async () => {
    const f = await fixture(
      "import {spawn} from 'node:child_process';for await(const chunk of process.stdin){} const child=spawn(process.execPath,['-e','setInterval(()=>{},100)'],{stdio:['ignore',1,2]});process.stdout.write(String(child.pid));process.exit(0);",
    );
    const result = await runGaapProcess(f.input);
    expect(result.status).toBe('ok');
    const pid = Number(result.stdout.toString());
    expect(pid).toBeGreaterThan(0);
    await expect
      .poll(
        () => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        },
        { timeout: 2000 },
      )
      .toBe(false);
  });
});
