import { execFileSync } from 'node:child_process';
import { observeGaapWorkspace } from '../adapters/fs/gaap-files.js';
import { parseRepositoryIdentity } from '../adapters/git/client.js';
import { canonicalJson } from '../domain/canonical-json.js';
import { workflowDigest } from '../domain/workflow-selection-types.js';
import type { PhysicalObservation, RunSnapshot } from '../domain/workflow-run.js';
import type { ControllerInput } from 'threadloop-contracts/controller';

function gitRead(root: string, args: string[]) {
  return execFileSync(
    'git',
    ['--no-replace-objects', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', root, ...args],
    {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 65_536,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    },
  ).trim();
}
function isNegative(error: unknown) {
  return error instanceof Error && 'status' in error && error.status === 1;
}
export function workflowGithubOrigin(root: string) {
  let origin: string;
  try {
    origin = gitRead(root, ['config', '--get', 'remote.origin.url']);
  } catch (error) {
    if (isNegative(error)) return null;
    throw error;
  }
  const parsed = parseRepositoryIdentity(origin, root);
  return parsed.host === 'github.com' && parsed.owner ? `https://github.com/${parsed.owner}/${parsed.name}` : null;
}
function ancestry(root: string, basis: string, revision: string) {
  if (basis === revision) return 'equal';
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(basis)) return 'unknown';
  try {
    gitRead(root, ['merge-base', '--is-ancestor', basis, revision]);
    return 'descendant';
  } catch (error) {
    return isNegative(error) ? 'unrelated' : 'unknown';
  }
}

export function observeWorkflow(snapshot: RunSnapshot): PhysicalObservation {
  const g = snapshot.genesis;
  const basis = snapshot.history.implementation_basis;
  const repositoryBasis = basis?.kind === 'repository' ? basis : null;
  const unavailable: ControllerInput['observation']['repository'] = {
    branch: null,
    clean: false,
    change_scope: 'unknown',
    basis: repositoryBasis,
    relationship: 'unknown',
  };
  let physical: PhysicalObservation['physical'] = null;
  let origin: string | null = null;
  let subject = snapshot.last_subject;
  let repository = unavailable;
  let status: 'verified' | 'unavailable' = 'unavailable';
  try {
    const observed = observeGaapWorkspace(g.subject_root);
    origin = workflowGithubOrigin(g.subject_root);
    if (g.sources?.github && origin !== g.setup.repository_id) throw new Error('The subject origin changed.');
    physical = observed;
    subject = {
      kind: 'repository',
      repository_id: g.setup.repository_id,
      revision: observed.revision,
      content_digest: observed.digest,
    };
    const prior = snapshot.implementation_manifest;
    let changeScope: 'within_plan' | 'outside_plan' | 'unknown' = 'unknown';
    if (prior !== null && repositoryBasis?.repository_id === subject.repository_id) {
      const names = new Set([...Object.keys(prior), ...Object.keys(observed.manifest)]);
      const changed = [...names].filter((name) => {
        const a = Object.hasOwn(prior, name) ? prior[name] : null;
        const b = Object.hasOwn(observed.manifest, name) ? observed.manifest[name] : null;
        return canonicalJson(a) !== canonicalJson(b);
      });
      const allowed = new Set(g.setup.allowed_change_paths);
      changeScope = changed.every((name) => allowed.has(name)) ? 'within_plan' : 'outside_plan';
    }
    repository = {
      branch: observed.branch || null,
      clean: observed.clean,
      basis: repositoryBasis,
      relationship:
        repositoryBasis?.repository_id === subject.repository_id
          ? ancestry(g.subject_root, repositoryBasis.revision, observed.revision)
          : 'unknown',
      change_scope: changeScope,
    };
    status = 'verified';
  } catch {
    // The run retains its last subject while the checkout is unavailable.
  }
  const facts = { subject, state_version: snapshot.view.state_version, status, valid_until: null, repository };
  return { subject, physical, origin, facts: { ...facts, id: workflowDigest(facts) } };
}
