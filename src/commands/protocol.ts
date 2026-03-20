import type { CommandContext } from './runtime.js';
import { writeCommandSuccess } from './runtime.js';

export type ProtocolPrintOptions = { json?: boolean };

const PROTOCOL = {
  envVars: {},
  commands: {
    init: 'threadloop init - Initialize ThreadLoop in the current Git repo',
    start: 'threadloop start <title> [--goal <goal>] [--base <ref>] - Start a task-scoped session (legacy)',
    capture: 'threadloop capture <kind> [text] [--session <id>] - Capture a checkpoint entry (kinds: decision, risk, note, question)',
    status: 'threadloop status [--session <id>] - Show current task/session status',
    'artifact generate': 'threadloop artifact generate [kind] [--session <id>] - Generate artifact (default: change-brief, kinds: change-brief, pr-summary, handoff)',
    finish: 'threadloop finish [--session <id>] - Complete the active session (legacy)',
    'session start': 'threadloop session start <title> [--goal <goal>] [--base <ref>] - Start a task-scoped session',
    'session list': 'threadloop session list - List sessions in the workspace',
    'session status': 'threadloop session status --session <id> - Show status for an explicit session',
    'session capture': 'threadloop session capture <kind> <text> --session <id> - Capture a checkpoint entry for explicit session',
    'session heartbeat': 'threadloop session heartbeat --session <id> - Refresh session metadata without creating semantic entries',
    'session reconcile': 'threadloop session reconcile --session <id>|-a|--all - Refresh Git-derived metadata',
    'session finish': 'threadloop session finish --session <id> - Finish an explicit session',
    'daemon run': 'threadloop daemon run [-i <seconds>] - Run daemon for periodic reconciliation',
    protocol: 'threadloop protocol [--json] - Print the agent integration protocol',
  },
  captureKinds: ['decision', 'risk', 'note', 'question'],
  artifactKinds: ['change-brief', 'pr-summary', 'handoff'],
  notes: [
    'All session-scoped commands support --session <id> for explicit targeting',
    'Use --json flag for machine-readable output on any command',
    'ThreadLoop-owned paths (.threadloop/) are excluded from Git scope',
    'Reconcile refreshes metadata without creating semantic entries',
    'Prefer session subcommands over legacy top-level commands for explicit targeting',
  ],
};

export async function protocolPrintCommand(context: CommandContext, options: ProtocolPrintOptions) {
  if (options.json) {
    writeCommandSuccess(context, { text: ['Protocol data'], data: PROTOCOL });
    return;
  }

  const lines = [
    '# ThreadLoop Agent Protocol',
    '',
    '## Commands',
    '',
  ];

  for (const [name, cmd] of Object.entries(PROTOCOL.commands)) {
    lines.push(`### ${name}`);
    lines.push('```');
    lines.push(cmd);
    lines.push('```');
    lines.push('');
  }

  lines.push('## Capture Kinds', '', PROTOCOL.captureKinds.map((k) => `- \`${k}\``).join('\n'), '');

  lines.push('## Artifact Kinds', '', PROTOCOL.artifactKinds.map((k) => `- \`${k}\``).join('\n'), '');

  lines.push('## Notes', '');

  for (const note of PROTOCOL.notes) {
    lines.push(`- ${note}`);
  }

  writeCommandSuccess(context, { text: lines, data: {} });
}
