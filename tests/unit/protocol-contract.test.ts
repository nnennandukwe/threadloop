import { describe, expect, it } from 'vitest';
import { createNoopCliHandlers, createThreadloopProgram } from '../../src/cli-program.js';
import { buildProtocolContract, collectLeafCommands, getCommandPath } from '../../src/contracts/protocol.js';

describe('protocol contract', () => {
  it('covers every leaf CLI command and reflects json support from the command tree', () => {
    const program = createThreadloopProgram(createNoopCliHandlers());
    const contract = buildProtocolContract();
    const leafCommands = collectLeafCommands(program);

    expect(Object.keys(contract.commands)).toEqual(leafCommands.map((command) => getCommandPath(command)));

    for (const command of leafCommands) {
      const path = getCommandPath(command);
      const usage = contract.commands[path];
      const supportsJson = command.options.some((option) => option.long === '--json');
      expect(usage.startsWith(`threadloop ${path}`)).toBe(true);
      expect(usage.includes('[--json]')).toBe(supportsJson);
    }
  });
});
