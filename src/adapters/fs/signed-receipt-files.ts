import { linkSync, readFileSync, unlinkSync } from 'node:fs';
import { sha256 } from '../crypto/sha256.js';
import type { SignedReceiptFileSystem } from '../../services/signed-receipt-files.js';

export const nodeSignedReceiptFileSystem: SignedReceiptFileSystem = {
  linkExclusive(sourcePath, targetPath) {
    linkSync(sourcePath, targetPath);
  },
  unlink(filePath) {
    unlinkSync(filePath);
  },
  sha256OrNull(filePath) {
    try {
      return sha256(readFileSync(filePath));
    } catch {
      return null;
    }
  },
};
