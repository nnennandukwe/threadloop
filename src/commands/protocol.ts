import type { CommandContext } from './runtime.js';
import { buildProtocolContract } from '../contracts/protocol.js';
import { writeCommandSuccess } from './runtime.js';

export type ProtocolPrintOptions = { json?: boolean };

export function protocolPrintCommand(context: CommandContext, options: ProtocolPrintOptions) {
  const protocol = buildProtocolContract();

  if (options.json) {
    writeCommandSuccess(context, { text: ['Protocol data'], data: protocol });
    return;
  }

  const lines = ['# ThreadLoop Agent Protocol', '', '## Contract Versions', ''];

  for (const [name, version] of Object.entries(protocol.contractVersions)) {
    lines.push(`- \`${name}\`: v${version}`);
  }

  lines.push('', '## Environment Variables', '');

  if (Object.keys(protocol.envVars).length === 0) {
    lines.push('No environment variables are part of the current contract.', '');
  } else {
    for (const [name, description] of Object.entries(protocol.envVars)) {
      lines.push(`- \`${name}\`: ${description}`);
    }
    lines.push('');
  }

  lines.push('## Commands', '');

  for (const [name, cmd] of Object.entries(protocol.commands)) {
    lines.push(`### ${name}`);
    lines.push('```');
    lines.push(cmd);
    lines.push('```');
    lines.push('');
  }

  lines.push('## Capture Kinds', '', protocol.captureKinds.map((kind) => `- \`${kind}\``).join('\n'), '');

  lines.push('## Artifact Kinds', '', protocol.artifactKinds.map((kind) => `- \`${kind}\``).join('\n'), '');

  lines.push(
    '## Workflow',
    '',
    `- Default base ref: \`${protocol.workflow.defaultBaseRef}\``,
    `- Branch naming: \`${protocol.workflow.branchNaming.default}\`; with issue \`${protocol.workflow.branchNaming.withIssue}\``,
    `- Rebase before PR: ${protocol.workflow.rebaseBeforePr.required ? `required onto \`${protocol.workflow.rebaseBeforePr.upstream}\`` : 'not required'}`,
    `- PR body artifact: \`${protocol.workflow.pr.bodyArtifact}\``,
    `- PR closing keyword: \`${protocol.workflow.pr.closingKeyword}\``,
    `- Tracked file mutations: \`${protocol.workflow.trackedFileMutations}\``,
    '',
  );

  lines.push('## Notes', '');

  for (const note of protocol.notes) {
    lines.push(`- ${note}`);
  }

  writeCommandSuccess(context, { text: lines, data: {} });
}
