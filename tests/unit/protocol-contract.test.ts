import { describe, expect, it } from 'vitest';
import { commandPath, createThreadloopProgram } from '../../src/cli-program.js';
import { buildProtocolContract, collectLeafCommands } from '../../src/contracts/protocol.js';

describe('protocol contract', () => {
  it('advertises graph runs only in the negotiated protocol', () => {
    const program = createThreadloopProgram();
    const current = buildProtocolContract(program, 5);
    expect(current.contractVersions).toMatchObject({ protocol: 5, workflowRun: 1 });
    expect(current.capabilities).toContain('workflow_runs_v1');
    expect(current.commands['workflow create']).toContain('--profile <yaml>');
    expect(buildProtocolContract(program, 4).commands).not.toHaveProperty('workflow create');
  });

  it('advertises overdue claim expiry and its required inputs only in v5', () => {
    const program = createThreadloopProgram();
    const current = buildProtocolContract(program, 5);
    const usage = 'threadloop workflow expire-claim <run> --attempt <id> --expected-state-version <n> [--json]';
    expect(current.commands['workflow expire-claim']).toContain(usage);
    expect(current.capabilities).toContain('workflow_claim_expiry_v1');
    expect(buildProtocolContract(program, 4).commands).not.toHaveProperty('workflow expire-claim');
  });

  it('keeps the installed v4 command set and reflects its JSON support', () => {
    const program = createThreadloopProgram();
    const contract = buildProtocolContract(program);
    const leafCommands = collectLeafCommands(program).filter((cmd) => !commandPath(cmd).startsWith('workflow '));

    expect(Object.keys(contract.commands)).toEqual(leafCommands.map((command) => commandPath(command)));
    expect(contract.contractVersions).toEqual({
      protocol: 4,
      proofPlan: 4,
      sessionNext: 4,
      signedReviewReceipt: 1,
      auditEvent: 1,
      handoff: 3,
    });

    for (const command of leafCommands) {
      const path = commandPath(command);
      const usage = contract.commands[path];
      expect(usage).toBeDefined();
      if (!usage) {
        throw new Error(`Missing protocol usage for ${path}`);
      }
      const supportsJson = command.options.some((option) => option.long === '--json');
      expect(usage.startsWith(`threadloop ${path}`)).toBe(true);
      expect(usage.includes('[--json]')).toBe(supportsJson);
    }

    expect(contract.workflow).toMatchObject({
      defaultBaseRef: 'main',
      branchNaming: {
        default: 'threadloop/<slug>',
        withIssue: 'issue-<issue>/<slug>',
      },
      rebaseBeforePr: {
        required: true,
        upstream: 'origin/main',
      },
      pr: {
        baseRef: 'main',
        bodyArtifact: 'pr-summary',
        closingKeyword: 'Closes',
      },
      trackedFileMutations: 'none',
    });
    expect(contract.commands['session gate import']).toBe(
      'threadloop session gate import <package-path> --session <id> [--json] - Verify and append one signed GitHub Actions gate receipt',
    );
    expect(contract.commands['session review import']).toBe(
      'threadloop session review import <package-path> --session <id> [--json] - Verify and append one signed GitHub review snapshot',
    );
    expect(contract.commands['audit export']).toContain(
      'threadloop audit export --session <id> --output <path> [--json]',
    );
    expect(contract.commands['audit corpus']).toContain('--format');
    expect(contract.notes).toContain(
      'Entering pre_pr_reviewing requires current-HEAD local proof and verified signed CI proof for every gate; post-PR human readiness additionally requires a current verified signed review receipt.',
    );
  });
});
