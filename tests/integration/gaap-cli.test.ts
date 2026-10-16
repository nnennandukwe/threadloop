import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { controllerFixture } from '../fixtures/gaap-controller.js';
import { runCli } from '../helpers/cli.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it('runs the packaged command tree through host adoption, admission and independent inspection', async () => {
  const fixture = await controllerFixture();
  roots.push(fixture.root);
  fixture.host.environment.TEST_GAAP_MAPPING = JSON.stringify(fixture.binding.mapping_policy);
  fixture.host.environment.TEST_GAAP_IMPLEMENTATION = JSON.stringify(fixture.host.verification.implementation);
  const binding = path.join(fixture.root, 'binding.json');
  const config = path.join(fixture.root, 'host.json');
  await writeFile(binding, JSON.stringify(fixture.binding));
  await writeFile(config, JSON.stringify(fixture.host));
  const register = await runCli(fixture.workspace, [
    'executor',
    'register',
    '--binding',
    binding,
    '--config',
    config,
    '--state',
    fixture.state,
    '--json',
  ]);
  expect((JSON.parse(register.stdout) as { ok: boolean }).ok).toBe(true);
  const execution = await runCli(fixture.workspace, ['executor', 'run', '--state', fixture.state, '--json']);
  const returned = JSON.parse(execution.stdout) as {
    ok: boolean;
    data: { status: string; evaluation: { workflow_state: string; lifecycle_mutated: boolean } };
  };
  expect(returned).toMatchObject({
    ok: true,
    data: { status: 'admitted', evaluation: { workflow_state: 'implementing', lifecycle_mutated: false } },
  });
  const inspected = await runCli(fixture.workspace, ['executor', 'inspect', '--state', fixture.state, '--json']);
  expect(
    (JSON.parse(inspected.stdout) as { data: { launch_count: number; admitted: unknown[] } }).data.admitted,
  ).toHaveLength(1);
  await expect(runCli(fixture.workspace, ['executor', 'run', '--state', fixture.state, '--json'])).rejects.toThrow();
  const adopted = await readFile(binding, 'utf8');
  expect(JSON.parse(adopted) as unknown).toEqual(fixture.binding);
});
