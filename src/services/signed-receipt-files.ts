export interface SignedReceiptFileSystem {
  linkExclusive(sourcePath: string, targetPath: string): void;
  unlink(filePath: string): void;
  sha256WithinLimitOrNull(filePath: string, maxBytes: number): string | null;
}
