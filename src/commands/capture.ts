import type { EntryKind } from '../domain/types.js';
import type { CommandContext } from './runtime.js';
import type { SessionCaptureOptions } from './session-capture.js';
import { sessionCaptureCommand } from './session-capture.js';

export async function captureCommand(context: CommandContext, kind: EntryKind, text: string | undefined, options: SessionCaptureOptions) {
  return sessionCaptureCommand(context, kind, text, options, true);
}
