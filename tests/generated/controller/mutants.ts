import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type * as Execution from 'threadloop-contracts/execution';
import type * as Controller from 'threadloop-contracts/controller';
import type { Scenario } from './scenario.js';

const started: Scenario['steps'] = [
  { kind: 'acquire', slot: 0, actor: 'a', lease: 5 },
  { kind: 'start', slot: 0, actor: 'a' },
];
const report: Scenario['steps'][number] = {
  kind: 'receipt',
  slot: 0,
  identity: 0,
  status: 'succeeded',
  effect: 'none',
  fault: 'none',
};
export const mutants = [
  {
    name: 'stale claim acceptance',
    file: 'scripts/execution-contract/model.js',
    before: 'deadlinePassed(claim.valid_until, now) ||',
    after: 'false ||',
    steps: [...started, { kind: 'clock', by: 5 }, report],
  },
  {
    name: 'duplicate advancement',
    file: 'scripts/execution-contract/model.js',
    before: 'const proposed = applied.value.replayed',
    after: 'const proposed = false',
    steps: [...started, report, { kind: 'redeliver', index: 2, changed: false }],
  },
  {
    name: 'stale receipt acceptance',
    file: 'scripts/execution-contract/model.js',
    before: '(fact.valid_until === null || fact.valid_until > now)',
    after: 'true',
    steps: [...started, { ...report, fault: 'expired_admission' }],
  },
  {
    name: 'executor-selected transition',
    file: 'scripts/controller-contract/decision.js',
    before: 'errors.push(...validateTransition(value, decision));',
    after: 'errors.push(...[]);',
    steps: [{ kind: 'executor_transition' }],
  },
] satisfies { name: string; file: string; before: string; after: string; steps: Scenario['steps'] }[];

export async function withMutant<T>(
  mutant: (typeof mutants)[number],
  action: (apis: { api: typeof Execution; controllerApi: typeof Controller }) => Promise<T>,
) {
  // Copy only the pinned executable contract package into an owned cache directory.
  // The installed dependency, source checkout and CLI bundle are never patched.
  const cache = path.resolve('node_modules/.cache');
  await mkdir(cache, { recursive: true });
  const root = await mkdtemp(path.join(cache, 'controller-mutant-'));
  try {
    const publicEntry = fileURLToPath(import.meta.resolve('threadloop-contracts/execution'));
    const distribution = path.resolve(path.dirname(publicEntry), '../..');
    await cp(distribution, root, { recursive: true });
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    const filename = path.join(root, mutant.file);
    const original = await readFile(filename, 'utf8');
    assert.equal(original.split(mutant.before).length, 2, `mutant patch must match exactly once: ${mutant.name}`);
    await writeFile(filename, original.replace(mutant.before, mutant.after));
    const api = (await import(pathToFileURL(path.join(root, 'src/public/execution.js')).href)) as typeof Execution;
    const controllerApi = (await import(
      pathToFileURL(path.join(root, 'src/public/controller.js')).href
    )) as typeof Controller;
    return await action({ api, controllerApi });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
