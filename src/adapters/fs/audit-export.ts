import { randomUUID } from 'node:crypto';
import { link, mkdir, open, rm } from 'node:fs/promises';
import path from 'node:path';

export class AuditExportConflictError extends Error {}

interface ExportFileSystem {
  mkdir: (directory: string, options: { recursive: true }) => Promise<unknown>;
  open: (
    file: string,
    flags: 'wx',
  ) => Promise<{ writeFile: (content: string) => Promise<unknown>; close: () => Promise<void> }>;
  link: (source: string, target: string) => Promise<void>;
  rm: (file: string, options: { force: true }) => Promise<void>;
}

export async function writeAuditExportExclusive(
  outputPath: string,
  content: string,
  files: ExportFileSystem = { link, mkdir, open, rm },
) {
  const directory = path.dirname(outputPath);
  await files.mkdir(directory, { recursive: true });
  const stagedPath = path.join(directory, `.${path.basename(outputPath)}.${randomUUID()}.tmp`);
  let owned = false;
  let committed = false;
  let failure: unknown;
  const warnings: string[] = [];
  try {
    const handle = await files.open(stagedPath, 'wx');
    owned = true;
    try {
      await handle.writeFile(content);
    } finally {
      await handle.close();
    }
    try {
      await files.link(stagedPath, outputPath);
      committed = true;
    } catch (error) {
      if (isErrorCode(error, 'EEXIST')) {
        throw new AuditExportConflictError(`Audit export already exists: ${outputPath}`, { cause: error });
      }
      throw error;
    }
  } catch (error) {
    failure = error;
  } finally {
    if (owned) {
      try {
        await files.rm(stagedPath, { force: true });
      } catch (cause) {
        if (committed) {
          warnings.push(`Export committed; remove the retained staging file after inspection: ${stagedPath}`);
        } else if (failure instanceof AuditExportConflictError) {
          failure = new AuditExportConflictError(
            `${failure.message}\nInspect and remove the retained staging file before retrying with a new output path.\n${stagedPath}`,
            { cause: new AggregateError([failure, cause], 'The output exists and staging cleanup failed.') },
          );
        } else {
          failure = new Error(`Export wasn't published; owned staging file needs removal before retry: ${stagedPath}`, {
            cause: failure ?? cause,
          });
        }
      }
    }
  }
  if (!committed) throw failure;
  return { warnings };
}

function isErrorCode(error: unknown, code: string) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
