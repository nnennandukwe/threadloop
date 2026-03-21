import type { CommandContext } from './runtime.js';
import { buildProtocolContract } from '../contracts/protocol.js';
import { writeCommandSuccess } from './runtime.js';

export type ProtocolPrintOptions = { json?: boolean };

export async function protocolPrintCommand(context: CommandContext, options: ProtocolPrintOptions) {
  const protocol = buildProtocolContract();

  if (options.json) {
    writeCommandSuccess(context, { text: ['Protocol data'], data: protocol });
    return;
  }

  const lines = [
    '# ThreadLoop Agent Protocol',
    '',
    '## Environment Variables',
    '',
  ];

  if (Object.keys(protocol.envVars).length === 0) {
    lines.push('No environment variables are part of the current contract.', '');
  } else {
    for (const [name, description] of Object.entries(protocol.envVars)) {
      lines.push(`- \`${name}\`: ${description}`);
    }
    lines.push('');
  }

  lines.push(
    '## Commands',
    '',
  );

  for (const [name, cmd] of Object.entries(protocol.commands)) {
    lines.push(`### ${name}`);
    lines.push('```');
    lines.push(cmd);
    lines.push('```');
    lines.push('');
  }

  lines.push('## Capture Kinds', '', protocol.captureKinds.map((kind) => `- \`${kind}\``).join('\n'), '');

  lines.push('## Artifact Kinds', '', protocol.artifactKinds.map((kind) => `- \`${kind}\``).join('\n'), '');

  lines.push('## Notes', '');

  for (const note of protocol.notes) {
    lines.push(`- ${note}`);
  }

  writeCommandSuccess(context, { text: lines, data: {} });
}
