import { realpath } from 'node:fs/promises';
import path from 'node:path';

export type BoundedFileReadResult = { status: 'ok'; bytes: Buffer } | { status: 'too_large'; sizeBytes: number };

export const MAX_SIGNED_RECEIPT_PACKAGE_BYTES = 10 * 1024 * 1024;

export interface SignedReceiptFileSystem {
  readWithinLimit(filePath: string, maxBytes: number): Promise<BoundedFileReadResult>;
  linkExclusive(sourcePath: string, targetPath: string): void;
  unlink(filePath: string): void;
  sha256WithinLimitOrNull(filePath: string, maxBytes: number): string | null;
}

export async function readControlledSignedReceiptPackageContents(input: {
  repoRoot: string;
  sessionId: string;
  receipts: Array<{ id: string; packagePath: string }>;
  fileSystem: SignedReceiptFileSystem;
}) {
  const contents = new Map<string, string | null>();
  const expectedRoot = path.resolve(input.repoRoot, '.threadloop', 'artifacts', 'receipts', input.sessionId);
  for (const receipt of input.receipts) {
    const packagePath = path.resolve(input.repoRoot, receipt.packagePath);
    const relative = path.relative(expectedRoot, packagePath);
    if (
      path.isAbsolute(receipt.packagePath) ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      contents.set(receipt.id, null);
      continue;
    }
    try {
      const [canonicalRoot, canonicalPackage] = await Promise.all([realpath(expectedRoot), realpath(packagePath)]);
      const canonicalRelative = path.relative(canonicalRoot, canonicalPackage);
      if (
        canonicalRelative === '..' ||
        canonicalRelative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(canonicalRelative)
      ) {
        contents.set(receipt.id, null);
        continue;
      }
      const packageRead = await input.fileSystem.readWithinLimit(canonicalPackage, MAX_SIGNED_RECEIPT_PACKAGE_BYTES);
      contents.set(receipt.id, packageRead.status === 'ok' ? packageRead.bytes.toString('utf8') : null);
    } catch {
      contents.set(receipt.id, null);
    }
  }
  return contents;
}
