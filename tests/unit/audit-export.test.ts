import * as fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { AuditExportConflictError, writeAuditExportExclusive } from '../../src/adapters/fs/audit-export.js';
import { cleanupTemporaryState, makeTempDir } from '../helpers/session.js';

afterEach(cleanupTemporaryState);

it('publishes exactly one complete target under concurrent writers and preserves it on retry', async () => {
  const dir = await makeTempDir();
  const output = path.join(dir, 'corpus.jsonl');
  const attempts = await Promise.allSettled(
    ['first\n', 'second\n'].map((content) => writeAuditExportExclusive(output, content)),
  );
  expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(['first\n', 'second\n']).toContain(await fs.readFile(output, 'utf8'));
  await expect(writeAuditExportExclusive(output, 'retry\n')).rejects.toThrow('already exists');
  expect(await fs.readdir(dir)).toEqual(['corpus.jsonl']);
});

it.each(['mkdir', 'open', 'write', 'close', 'link'] as const)(
  'preserves the target boundary when %s fails',
  async (phase) => {
    const dir = await makeTempDir();
    const output = path.join(dir, 'corpus.jsonl');
    const failure = new Error(`injected ${phase}`);
    const operations = {
      ...fs,
      mkdir: async (...args: Parameters<typeof fs.mkdir>) => {
        if (phase === 'mkdir') throw failure;
        return fs.mkdir(...args);
      },
      open: async (...args: Parameters<typeof fs.open>) => {
        if (phase === 'open') throw failure;
        const handle = await fs.open(...args);
        return {
          writeFile: async (content: string) => {
            await handle.writeFile(content.slice(0, 1));
            if (phase === 'write') throw failure;
            await handle.writeFile(content.slice(1));
          },
          close: async () => {
            await handle.close();
            if (phase === 'close') throw failure;
          },
        };
      },
      link: async (...args: Parameters<typeof fs.link>) => {
        if (phase === 'link') throw failure;
        return fs.link(...args);
      },
    };
    await expect(writeAuditExportExclusive(output, 'complete\n', operations)).rejects.toThrow(failure.message);
    await expect(fs.readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readdir(dir)).toEqual([]);
    await writeAuditExportExclusive(output, 'recovered\n');
    expect(await fs.readFile(output, 'utf8')).toBe('recovered\n');
  },
);

it('reports committed cleanup failure as success with a warning and a verifiable target', async () => {
  const dir = await makeTempDir();
  const output = path.join(dir, 'corpus.jsonl');
  const result = await writeAuditExportExclusive(output, 'complete\n', {
    ...fs,
    rm: () => Promise.reject(new Error('injected cleanup')),
  });
  expect(result.warnings).toEqual([expect.stringContaining('staging')]);
  expect(await fs.readFile(output, 'utf8')).toBe('complete\n');
  expect(await fs.readdir(dir)).toHaveLength(2);
});

it('preserves an unowned staging collision and reports a retained owned stage after failed abort cleanup', async () => {
  const dir = await makeTempDir();
  const output = path.join(dir, 'corpus.jsonl');
  let unowned = '';
  await expect(
    writeAuditExportExclusive(output, 'data', {
      ...fs,
      open: async (file) => {
        unowned = file;
        await fs.writeFile(file, 'someone else');
        throw Object.assign(new Error('injected collision'), { code: 'EEXIST' });
      },
    }),
  ).rejects.toThrow('injected collision');
  expect(await fs.readFile(unowned, 'utf8')).toBe('someone else');
  await expect(
    writeAuditExportExclusive(output, 'data', {
      ...fs,
      link: () => Promise.reject(new Error('injected link')),
      rm: () => Promise.reject(new Error('injected cleanup')),
    }),
  ).rejects.toThrow('owned staging file needs removal');
  await expect(fs.readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readFile(unowned, 'utf8')).toBe('someone else');
});

it('retains the output conflict and identifies its staging file when cleanup also fails', async () => {
  const dir = await makeTempDir();
  const output = path.join(dir, 'chosen.jsonl');
  await fs.writeFile(output, 'first export');
  const cleanupFailure = new Error('Injected staging removal failure');
  let retained = '';
  const attempt = writeAuditExportExclusive(output, 'second export', {
    ...fs,
    rm: (file) => {
      retained = file;
      return Promise.reject(cleanupFailure);
    },
  });
  await expect(attempt).rejects.toBeInstanceOf(AuditExportConflictError);
  await expect(attempt).rejects.toMatchObject({
    message: expect.stringContaining(retained) as unknown,
    cause: {
      errors: [
        expect.objectContaining({ cause: expect.objectContaining({ code: 'EEXIST' }) as unknown }),
        cleanupFailure,
      ],
    },
  });
  await expect(attempt).rejects.toThrow('new output path');
  expect(await fs.readFile(output, 'utf8')).toBe('first export');
  expect(await fs.readFile(retained, 'utf8')).toBe('second export');
  const retry = path.join(dir, 'fresh.jsonl');
  await writeAuditExportExclusive(retry, 'second export');
  expect(await fs.readFile(retry, 'utf8')).toBe('second export');
});
