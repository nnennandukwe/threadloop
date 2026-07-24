import { closeSync, fstatSync, linkSync, openSync, readSync, unlinkSync } from 'node:fs';
import { sha256 } from '../crypto/sha256.js';
import type { SignedReceiptFileSystem } from '../../services/signed-receipt-files.js';

export const nodeSignedReceiptFileSystem: SignedReceiptFileSystem = {
  linkExclusive(sourcePath, targetPath) {
    linkSync(sourcePath, targetPath);
  },
  unlink(filePath) {
    unlinkSync(filePath);
  },
  sha256WithinLimitOrNull(filePath, maxBytes) {
    let fileDescriptor: number | null = null;
    try {
      fileDescriptor = openSync(filePath, 'r');
      const metadata = fstatSync(fileDescriptor);
      if (!metadata.isFile() || metadata.size > maxBytes) {
        return null;
      }

      const bytes = Buffer.alloc(metadata.size);
      let offset = 0;
      while (offset < bytes.length) {
        const bytesRead = readSync(fileDescriptor, bytes, offset, bytes.length - offset, offset);
        if (bytesRead === 0) {
          return null;
        }
        offset += bytesRead;
      }
      if (readSync(fileDescriptor, Buffer.alloc(1), 0, 1, bytes.length) !== 0) {
        return null;
      }
      return sha256(bytes);
    } catch {
      return null;
    } finally {
      if (fileDescriptor !== null) {
        try {
          closeSync(fileDescriptor);
        } catch {
          // The digest operation already fails closed; cleanup cannot make it authoritative.
        }
      }
    }
  },
};
