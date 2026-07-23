import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveGitPath } from '../git/client.js';

const STATE_IGNORE_ENTRY = '.threadloop/state/';
const RECEIPTS_IGNORE_ENTRY = '.threadloop/artifacts/receipts/';
const LOCAL_IGNORE_ENTRIES = [STATE_IGNORE_ENTRY, RECEIPTS_IGNORE_ENTRY] as const;

export type GitignoreStatus = 'created' | 'updated' | 'already-correct';

export async function ensureThreadloopStateIgnored(repoRoot: string): Promise<GitignoreStatus> {
  const excludePath = await resolveGitPath(repoRoot, 'info/exclude');
  await mkdir(path.dirname(excludePath), { recursive: true });

  if (!existsSync(excludePath)) {
    await writeFile(excludePath, `${LOCAL_IGNORE_ENTRIES.join('\n')}\n`, 'utf8');
    return 'created';
  }

  const current = await readFile(excludePath, 'utf8');
  const lines = current
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const missingEntries = LOCAL_IGNORE_ENTRIES.filter((entry) => !coversThreadloopPath(lines, entry));
  if (missingEntries.length === 0) {
    return 'already-correct';
  }

  const next =
    current.endsWith('\n') || current.length === 0
      ? `${current}${missingEntries.join('\n')}\n`
      : `${current}\n${missingEntries.join('\n')}\n`;
  await writeFile(excludePath, next, 'utf8');
  return 'updated';
}

function coversThreadloopPath(lines: string[], target: string) {
  return lines.some((line) => {
    if (line.startsWith('#') || line.startsWith('!')) {
      return false;
    }

    return (
      line === '.threadloop' ||
      line === '.threadloop/' ||
      line === '.threadloop/*' ||
      line === '.threadloop/**' ||
      line === target
    );
  });
}
