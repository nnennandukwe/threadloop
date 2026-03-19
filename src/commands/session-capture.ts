import { readTextFromEditor } from '../adapters/fs/editor.js';
import { ThreadloopError, createInvalidArgumentError } from '../contracts/errors.js';
import { ENTRY_KINDS, type EntryKind } from '../domain/types.js';
import { captureEntry } from '../services/session-service.js';
import { toSessionId, type CommandContext, type JsonOption, type SessionOption, writeCommandSuccess } from './runtime.js';

export interface SessionCaptureOptions extends JsonOption, SessionOption {
  because?: string;
  edit?: boolean;
}

export async function sessionCaptureCommand(
  context: CommandContext,
  kindValue: string,
  text: string | undefined,
  options: SessionCaptureOptions,
  allowLegacySingleActive = false,
) {
  const sessionId = toSessionId(options);
  if (!sessionId && !allowLegacySingleActive) {
    throw new ThreadloopError('SESSION_REQUIRED', 'A session id is required for this command.', {
      details: { hint: 'Pass --session <id>.' },
    });
  }

  const body = options.edit ? await readTextFromEditor(text ?? '') : text?.trim();
  if (!body) {
    throw createInvalidArgumentError('Capture text is required. Pass text directly or use --edit.');
  }

  if (!ENTRY_KINDS.includes(kindValue as EntryKind)) {
    throw createInvalidArgumentError(`Entry kind must be one of: ${ENTRY_KINDS.join(', ')}`, {
      kind: kindValue,
    });
  }

  const result = await captureEntry({
    cwd: context.cwd,
    sessionId,
    kind: kindValue as EntryKind,
    body,
    because: options.because,
  });

  writeCommandSuccess(context, {
    text: [`Captured ${result.entry.kind}: ${result.entry.body}`, `Session: ${result.session.id}`],
    data: {
      session_id: result.session.id,
      task: result.task,
      session: result.session,
      entry: result.entry,
    },
  });
}
