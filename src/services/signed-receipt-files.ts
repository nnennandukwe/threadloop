export interface SignedReceiptFileSystem {
  linkExclusive(sourcePath: string, targetPath: string): void;
  unlink(filePath: string): void;
  sha256OrNull(filePath: string): string | null;
}
