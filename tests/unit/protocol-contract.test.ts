import { describe, expect, it } from 'vitest';
import { createNoopCliHandlers, createThreadloopProgram } from '../../src/cli-program.js';
import { buildProtocolContract, collectLeafCommands, getCommandPath } from '../../src/contracts/protocol.js';

describe('protocol contract', () => {
  it('covers every leaf CLI command and reflects json support from the command tree', () => {
    const program = createThreadloopProgram(createNoopCliHandlers());
    const contract = buildProtocolContract();
    const leafCommands = collectLeafCommands(program);

    expect(Object.keys(contract.commands)).toEqual(leafCommands.map((command) => getCommandPath(command)));
    expect(contract.contractVersions).toEqual({
      protocol: 4,
      proofPlan: 4,
      sessionNext: 4,
      signedReviewReceipt: 1,
      auditEvent: 1,
      handoff: 3,
    });

    for (const command of leafCommands) {
      const path = getCommandPath(command);
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
    expect(contract.notes).toContain(
      'Entering pre_pr_reviewing requires current-HEAD local proof and verified signed CI proof for every gate; post-PR human readiness additionally requires a current verified signed review receipt.',
    );
  });
});
