import { readFile, readdir } from 'node:fs/promises';
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

async function fingerprintImplementation() {
  const modulePath = fileURLToPath(import.meta.url);
  const source = modulePath.endsWith('.ts');
  const root = source ? path.resolve(path.dirname(modulePath), '../../..') : path.dirname(modulePath);
  const files = source
    ? [
        'package.json',
        'package-lock.json',
        ...(await readdir(path.join(root, 'src'), { recursive: true }))
          .filter((name) => name.endsWith('.ts'))
          .map((name) => `src/${name}`),
      ]
    : (await readdir(root)).filter((name) => name.endsWith('.js'));
  const hashes = await Promise.all(files.sort().map(async (name) => [name, await sha256File(path.join(root, name))]));
  return {
    implementation_sha256: sha256(canonicalJson({ files: hashes, dependency_lock: sha256(canonicalJson(lockfile)) })),
    implementation_scope: source ? ('source_and_lockfile' as const) : ('javascript_bundle' as const),
  };
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
