import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export async function readTextFromEditor(initialContent = '') {
  const editor = process.env.EDITOR;
  if (!editor) {
    throw new Error('No $EDITOR configured. Set EDITOR or pass text directly.');
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'threadloop-editor-'));
  const tempFile = path.join(tempDir, 'entry.md');
  await writeFile(tempFile, initialContent, 'utf8');

  const result = spawnSync(`${editor} "${tempFile}"`, {
    shell: true,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    await rm(tempDir, { recursive: true, force: true });
    throw new Error(`Editor exited with status ${result.status ?? 'unknown'}.`);
  }

  const content = (await readFile(tempFile, 'utf8')).trim();
  await rm(tempDir, { recursive: true, force: true });

  if (!content) {
    throw new Error('No content was provided.');
  }

  return content;
}
