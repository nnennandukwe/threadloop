import { randomUUID } from 'node:crypto';
import { link, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class AuditExportConflictError extends Error {}

export async function writeAuditExportExclusive(outputPath: string, content: string) {
  const directory = path.dirname(outputPath);
  await mkdir(directory, { recursive: true });
  const stagedPath = path.join(directory, `.${path.basename(outputPath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(stagedPath, content, { encoding: 'utf8', flag: 'wx' });
    try {
      await link(stagedPath, outputPath);
    } catch (error) {
      if (isErrorCode(error, 'EEXIST')) {
        throw new AuditExportConflictError(`Audit export already exists: ${outputPath}`);
      }
      throw error;
    }
  } finally {
    await rm(stagedPath, { force: true });
  }
}

function isErrorCode(error: unknown, code: string) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
