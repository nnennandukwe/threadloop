import { closeSync, fstatSync, linkSync, openSync, readSync, unlinkSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { sha256 } from '../crypto/sha256.js';
import type { SignedReceiptFileSystem } from '../../services/signed-receipt-files.js';

export const nodeSignedReceiptFileSystem: SignedReceiptFileSystem = {
  async readWithinLimit(filePath, maxBytes) {
    const file = await open(filePath, 'r');
    try {
      const metadata = await file.stat();
      if (!metadata.isFile()) {
        throw new Error('Signed receipt package path is not a regular file.');
      }
      if (metadata.size > maxBytes) {
        return { status: 'too_large', sizeBytes: metadata.size };
      }

      const bytes = Buffer.alloc(metadata.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
        if (bytesRead === 0) {
          throw new Error('Signed receipt package changed while it was being read.');
        }
        offset += bytesRead;
      }

      const extraByte = Buffer.allocUnsafe(1);
      const { bytesRead: extraBytesRead } = await file.read(extraByte, 0, 1, bytes.length);
      if (extraBytesRead !== 0) {
        return { status: 'too_large', sizeBytes: bytes.length + extraBytesRead };
      }
      return { status: 'ok', bytes };
    } finally {
      await file.close();
    }
  },
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
