import { readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import packageInfo from '../../../package.json' with { type: 'json' };
import lockfile from '../../../package-lock.json' with { type: 'json' };
import { ThreadloopError } from '../../contracts/errors.js';
import { PROTOCOL_COMPONENT_VERSIONS } from '../../contracts/versions.js';
import { canonicalJson } from '../../domain/canonical-json.js';
import { canonicalizeProofPlan } from '../../domain/proof.js';
import { runConfigurationInputSchema, type RunConfiguration } from '../../domain/run-configuration.js';
import { sha256, sha256File } from '../crypto/sha256.js';
import { CURRENT_SCHEMA_VERSION } from './sqlite-store.js';

async function hashImplementation(root: string, files: string[], scope: RunConfiguration['implementation_scope']) {
  files.sort();
  const hashes: Array<[string, string]> = [];
  // The npm package contains thousands of files. Bound concurrently opened streams across the whole snapshot.
  for (let offset = 0; offset < files.length; offset += 16) {
    const batch = files.slice(offset, offset + 16);
    hashes.push(
      ...(await Promise.all(
        batch.map(async (name): Promise<[string, string]> => [name, await sha256File(path.join(root, name))]),
      )),
    );
  }
  return {
    implementation_sha256: sha256(canonicalJson({ files: hashes, dependency_lock: sha256(canonicalJson(lockfile)) })),
    implementation_scope: scope,
  };
}

async function installedPackageFiles(root: string) {
  const files = ['package.json'];
  const bundled = Object.entries(lockfile.packages)
    .filter(([, entry]) => 'inBundle' in entry && entry.inBundle)
    .map(([name]) => name);
  const directories = ['dist', ...bundled];
  for (const name of [...files, ...directories]) {
    const target = path.join(root, name);
    try {
      // A linked package may point into the caller's workspace. Keep the narrower bundle scope for that layout.
      if ((await realpath(target)) !== target) return null;
    } catch (cause) {
      if (!(cause instanceof Error) || !('code' in cause) || cause.code !== 'ENOENT') throw cause;
      return null;
    }
  }
  while (directories.length) {
    const directory = directories.pop()!;
    for (const item of await readdir(path.join(root, directory), { withFileTypes: true })) {
      // Each nested bundled package has its own lock entry, including different versions of the same package.
      if (item.name === 'node_modules') continue;
      const name = path.posix.join(directory, item.name);
      if (item.isDirectory()) directories.push(name);
      else if (item.isFile()) files.push(name);
      else return null;
    }
  }
  return files;
}

async function fingerprintImplementation() {
  const modulePath = fileURLToPath(import.meta.url);
  const source = modulePath.endsWith('.ts');
  const root = source ? path.resolve(path.dirname(modulePath), '../../..') : path.dirname(modulePath);
  const packageRoot = path.dirname(root);
  if (!source && path.basename(root) === 'dist' && path.basename(path.dirname(packageRoot)) === 'node_modules') {
    const files = await installedPackageFiles(packageRoot);
    if (files !== null) return hashImplementation(packageRoot, files, 'npm_bundled_files');
  }
  const files = source
    ? [
        'package.json',
        'package-lock.json',
        ...(await readdir(path.join(root, 'src'), { recursive: true }))
          .filter((name) => name.endsWith('.ts') || name.endsWith('.json'))
          .map((name) => `src/${name.split(path.sep).join('/')}`),
      ]
    : (await readdir(root)).filter((name) => name.endsWith('.js'));
  return hashImplementation(root, files, source ? 'source_and_lockfile' : 'javascript_bundle');
}

export async function captureRunConfiguration(cwd: string, configPath?: string): Promise<RunConfiguration> {
  let declared: Pick<RunConfiguration, 'caller' | 'proof_plan_sha256' | 'runner_skill_sha256'> = {
    caller: null,
    proof_plan_sha256: null,
    runner_skill_sha256: null,
  };
  if (configPath !== undefined) {
    try {
      const resolved = path.resolve(cwd, configPath);
      const config = runConfigurationInputSchema.parse(JSON.parse(await readFile(resolved, 'utf8')));
      const plan = JSON.parse(
        await readFile(path.resolve(path.dirname(resolved), config.proof_plan_path), 'utf8'),
      ) as unknown;
      declared = {
        caller: { harness: config.harness, model: config.model },
        proof_plan_sha256: canonicalizeProofPlan(plan, sha256).sha256,
        runner_skill_sha256: await sha256File(path.resolve(path.dirname(resolved), config.runner_skill_path)),
      };
    } catch (cause) {
      throw new ThreadloopError('INVALID_ARGUMENT', 'Run configuration or one of its snapshot files is invalid.', {
        cause,
        details: {
          field: 'run_config',
          hint: 'Provide harness, model, proof_plan_path, and runner_skill_path; resolve artifact paths from the configuration file directory.',
        },
      });
    }
  }
  return {
    schema_version: 'threadloop.run-configuration/1',
    threadloop_version: packageInfo.version,
    ...(await fingerprintImplementation()),
    storage_schema_version: CURRENT_SCHEMA_VERSION,
    protocol_components: { ...PROTOCOL_COMPONENT_VERSIONS },
    ...declared,
  };
}
