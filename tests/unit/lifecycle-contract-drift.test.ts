import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import {
  deriveLifecyclePhase,
  evaluateLifecycleTransition,
  isForwardLifecycleTransition,
  REPAIR_BUDGET,
  REPAIR_ENTRY_STATES,
} from '../../src/domain/lifecycle.js';
import { LIFECYCLE_PHASE, TASK_STATUS_VALUES } from '../../src/domain/types.js';

// Byte-for-byte copies of docs/contracts/workflow-graph-v0.1/ from nnennandukwe/threadloop-contracts at v0.1.0. That
// contract's Governed PR profile specifies this runtime's lifecycle, so these tests fail when the two drift apart.
// Update by re-copying from a new contract release, never by editing the copies.
const vendored = new URL('../fixtures/threadloop-contracts-v0.1/', import.meta.url);
const VENDORED_SHA256 = {
  'governed-pr.yaml': 'cfd9272313dcee235ed4347066dea390d01ecf9ad3975916c51f777cdd46faf1',
  'preservation.json': 'dfe04b0bce54df69a6ad3c5985f106fe1428ac152ea61f23f76480d95dce457a',
};

interface GovernedPrProfile {
  states: Array<{ id: string }>;
  transitions: Array<{ id: string; from: string; to: string }>;
  budgets: Array<{ id: string; limit: number; transition_refs: string[] }>;
  phase_policy: {
    initial: string;
    advanced: string;
    monotonic: boolean;
    include_audit_genesis: boolean;
    state_refs: string[];
  };
}

async function readVendored(name: keyof typeof VENDORED_SHA256) {
  return readFile(new URL(name, vendored), 'utf8');
}

async function governedPr() {
  return parse(await readVendored('governed-pr.yaml')) as GovernedPrProfile;
}

describe('Governed PR contract v0.1 and the runtime lifecycle', () => {
  it('reads unmodified copies of the v0.1 release', async () => {
    for (const [name, digest] of Object.entries(VENDORED_SHA256)) {
      expect(sha256(await readVendored(name as keyof typeof VENDORED_SHA256)), name).toBe(digest);
    }
  });

  it('maps every runtime state and structural forward transition', async () => {
    const profile = await governedPr();
    expect(profile.states.map((state) => state.id).sort()).toEqual([...TASK_STATUS_VALUES].sort());
    const expected = TASK_STATUS_VALUES.flatMap((from) =>
      TASK_STATUS_VALUES.filter((to) => isForwardLifecycleTransition(from, to)).map((to) => `${from}:${to}`),
    ).sort();
    const mapped = [
      ...new Set(
        profile.transitions
          .filter((edge) => edge.from !== 'blocked' && edge.to !== 'blocked')
          .map((edge) => `${edge.from}:${edge.to}`),
      ),
    ].sort();
    expect(mapped).toEqual(expected);
  });

  it('blocks from, and recovers to, exactly the states the runtime allows', async () => {
    const profile = await governedPr();
    const edges = new Set(profile.transitions.map((edge) => `${edge.from}:${edge.to}`));
    for (const state of TASK_STATUS_VALUES.filter((candidate) => candidate !== 'blocked')) {
      expect(evaluateLifecycleTransition(state, 'blocked').allowed, `${state} -> blocked`).toBe(
        edges.has(`${state}:blocked`),
      );
      expect(
        evaluateLifecycleTransition('blocked', state, { blockedFromState: state }).allowed,
        `blocked -> ${state}`,
      ).toBe(edges.has(`blocked:${state}`));
    }
  });

  it('enters the post-PR phase on the same states, monotonically, including an audit genesis', async () => {
    const { phase_policy: policy } = await governedPr();
    expect([policy.initial, policy.advanced]).toEqual([LIFECYCLE_PHASE.PRE_PR, LIFECYCLE_PHASE.POST_PR]);
    expect(deriveLifecyclePhase([])).toBe(policy.initial);
    for (const state of TASK_STATUS_VALUES) {
      const expected = policy.state_refs.includes(state) ? policy.advanced : policy.initial;
      expect(deriveLifecyclePhase([{ to_state: state }]), state).toBe(expected);
      expect(deriveLifecyclePhase([], policy.include_audit_genesis ? state : null), `genesis ${state}`).toBe(expected);
    }
    expect(policy.monotonic).toBe(true);
    expect(deriveLifecyclePhase([{ to_state: 'reviewing' }, { to_state: 'repairing' }])).toBe(policy.advanced);
  });

  it('counts exactly the runtime repair entries against the same repair limit', async () => {
    const profile = await governedPr();
    const [budget] = profile.budgets;
    expect(budget?.limit).toBe(REPAIR_BUDGET);
    expect(
      profile.transitions
        .filter((edge) => budget?.transition_refs.includes(edge.id))
        .map((edge) => `${edge.from}:${edge.to}`)
        .sort(),
    ).toEqual(REPAIR_ENTRY_STATES.map((state) => `${state}:repairing`).sort());
  });

  it('lists the same required-work codes as the lifecycle graph mapping document', async () => {
    const manifest = JSON.parse(await readVendored('preservation.json')) as { required_work: Array<{ code: string }> };
    const mapping = await readFile(new URL('../../docs/current-lifecycle-graph-mapping.md', import.meta.url), 'utf8');
    const table =
      mapping.split('## Guard And Required Work Mapping')[1]?.split('## Receipt And Observation Mapping')[0] ?? '';
    const mappedCodes = [
      ...new Set(
        table
          .split('\n')
          .filter((line) => line.startsWith('|'))
          .flatMap((line) => [...(line.split('|')[3] ?? '').matchAll(/`([A-Z][A-Z0-9_]+)`/g)].map((match) => match[1])),
      ),
    ].sort();
    expect(mappedCodes.length).toBeGreaterThan(20);
    expect(manifest.required_work.map((item) => item.code).sort()).toEqual(mappedCodes);
  });
});
