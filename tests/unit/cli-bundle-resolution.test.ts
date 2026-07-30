import { mkdtemp, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveTestCliBundle, THREADLOOP_TEST_CLI_ENV } from '../helpers/cli.js';

const publishedBundle = process.env[THREADLOOP_TEST_CLI_ENV];

afterEach(() => {
  if (publishedBundle === undefined) {
    delete process.env[THREADLOOP_TEST_CLI_ENV];
  } else {
    process.env[THREADLOOP_TEST_CLI_ENV] = publishedBundle;
  }
});

async function makeBundle(modifiedAt: Date) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'threadloop-bundle-guard-'));
  const bundlePath = path.join(directory, 'cli.js');
  await writeFile(bundlePath, '// pretend bundle\n', 'utf8');
  await utimes(bundlePath, modifiedAt, modifiedAt);
  return bundlePath;
}

describe('test CLI bundle resolution', () => {
  it('accepts a bundle newer than src/', async () => {
    const bundlePath = await makeBundle(new Date(Date.now() + 60_000));
    process.env[THREADLOOP_TEST_CLI_ENV] = bundlePath;

    expect(resolveTestCliBundle()).toBe(bundlePath);
  });

  it('rejects a bundle older than src/ instead of asserting against a stale build', async () => {
    const bundlePath = await makeBundle(new Date(0));
    process.env[THREADLOOP_TEST_CLI_ENV] = bundlePath;

    expect(() => resolveTestCliBundle()).toThrow(/older than src\//);
    // The message has to say how to recover, not just that something is wrong.
    expect(() => resolveTestCliBundle()).toThrow(/restart vitest/i);
  });

  it('rejects a missing bundle rather than falling back to the slow path', () => {
    process.env[THREADLOOP_TEST_CLI_ENV] = path.join(os.tmpdir(), 'threadloop-bundle-guard-absent', 'cli.js');

    expect(() => resolveTestCliBundle()).toThrow(/does not exist/);
  });

  it('rejects an unset bundle path and names what publishes it', () => {
    delete process.env[THREADLOOP_TEST_CLI_ENV];

    expect(() => resolveTestCliBundle()).toThrow(/global-setup/);
  });

  it('resolves the bundle that global setup actually published', () => {
    expect(publishedBundle).toBeDefined();
    expect(resolveTestCliBundle()).toBe(publishedBundle);
  });
});
