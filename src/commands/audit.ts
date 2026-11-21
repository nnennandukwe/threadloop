import { exportSessionAudit, showSessionAudit, verifySessionAudit } from '../services/session-service.js';
import { type CommandContext, writeCommandSuccess } from './runtime.js';
import { exportAuditCorpus, verifyAuditExport } from '../services/audit-corpus.js';

interface AuditSessionOptions {
  session: string;
}

export async function auditCorpusCommand(
  context: CommandContext,
  options: { session?: string[]; all?: boolean; output: string },
) {
  const result = await exportAuditCorpus({
    cwd: context.cwd,
    ...options,
    ...(options.session ? { sessionIds: options.session } : {}),
  });
  writeCommandSuccess(context, {
    text: [
      `Exported ${result.session_count} session(s), ${result.event_count} event(s): ${result.output}`,
      `Corpus root: ${result.root}`,
      ...result.warnings,
    ],
    data: result,
  });
}

export async function auditVerifyExportCommand(context: CommandContext, options: { input: string; root?: string }) {
  const result = await verifyAuditExport({ cwd: context.cwd, ...options });
  writeCommandSuccess(context, {
    text: [`Verified ${result.session_count} session(s): ${result.input}`, `Corpus root: ${result.root}`],
    data: result,
  });
}

export async function auditShowCommand(context: CommandContext, options: AuditSessionOptions) {
  const result = await showSessionAudit({ cwd: context.cwd, sessionId: options.session });
  writeCommandSuccess(context, {
    text: [
      `Audit ${result.session_id}: ${result.count} event(s)`,
      `Root: ${result.root}`,
      `Coverage: ${result.coverage}`,
      `Valid: ${result.verification.valid}`,
      'Events:',
      ...result.events.map(
        ({ event, event_sha256 }) => `#${event.sequence} ${event.event_type} ${event.recorded_at} ${event_sha256}`,
      ),
    ],
    data: result,
  });
}

export async function auditVerifyCommand(context: CommandContext, options: AuditSessionOptions & { root?: string }) {
  const result = await verifySessionAudit({
    cwd: context.cwd,
    sessionId: options.session,
    ...(options.root ? { expectedRoot: options.root } : {}),
  });
  writeCommandSuccess(context, {
    text: [`Audit ${result.session_id}: valid`, `Events: ${result.count}`, `Root: ${result.root}`],
    data: result,
  });
}

export async function auditExportCommand(context: CommandContext, options: AuditSessionOptions & { output: string }) {
  const result = await exportSessionAudit({
    cwd: context.cwd,
    sessionId: options.session,
    outputPath: options.output,
  });
  writeCommandSuccess(context, {
    text: [
      `Exported ${result.count} audit event(s): ${result.output}`,
      `Root: ${result.root}`,
      ...(result.warnings ?? []),
    ],
    data: result,
  });
}
