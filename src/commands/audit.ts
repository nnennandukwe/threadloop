import { exportSessionAudit, showSessionAudit, verifySessionAudit } from '../services/session-service.js';
import { type CommandContext, writeCommandSuccess } from './runtime.js';

interface AuditSessionOptions {
  session: string;
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
    text: [`Exported ${result.count} audit event(s): ${result.output}`, `Root: ${result.root}`],
    data: result,
  });
}
