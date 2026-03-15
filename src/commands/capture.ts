import { readTextFromEditor } from '../adapters/fs/editor.js';
import type { EntryKind } from '../domain/types.js';
import { captureEntry } from '../services/session-service.js';

interface CaptureOptions {
  because?: string;
  edit?: boolean;
}

export async function captureCommand(kind: EntryKind, text: string | undefined, options: CaptureOptions) {
  const body = options.edit ? await readTextFromEditor(text ?? '') : text?.trim();

  if (!body) {
    throw new Error('Capture text is required. Pass text directly or use --edit.');
  }

  const result = await captureEntry({
    cwd: process.cwd(),
    kind,
    body,
    because: options.because,
  });

  console.log(`Captured ${result.entry.kind}: ${result.entry.body}`);
}
