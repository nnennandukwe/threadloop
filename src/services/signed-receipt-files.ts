export type BoundedFileReadResult = { status: 'ok'; bytes: Buffer } | { status: 'too_large'; sizeBytes: number };

export interface SignedReceiptFileSystem {
  readWithinLimit(filePath: string, maxBytes: number): Promise<BoundedFileReadResult>;
  linkExclusive(sourcePath: string, targetPath: string): void;
  unlink(filePath: string): void;
  sha256WithinLimitOrNull(filePath: string, maxBytes: number): string | null;
}
