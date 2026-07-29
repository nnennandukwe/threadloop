import { exportSessionAudit, showSessionAudit, verifySessionAudit } from '../services/session-service.js';
import { type CommandContext, type JsonOption, writeCommandSuccess } from './runtime.js';

export interface AuditSessionOptions extends JsonOption {
  session: string;
}

export interface AuditVerifyOptions extends AuditSessionOptions {
  root?: string;
}

export interface AuditExportOptions extends AuditSessionOptions {
  output: string;
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

export async function auditVerifyCommand(context: CommandContext, options: AuditVerifyOptions) {
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

export async function auditExportCommand(context: CommandContext, options: AuditExportOptions) {
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
