import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import { createAuditEvent, ZERO_AUDIT_HASH } from '../../src/domain/audit.js';
import { createAuditCorpus, verifyAuditCorpus } from '../../src/domain/audit-corpus.js';
import { cleanupTemporaryState, makeTempDir } from '../helpers/session.js';

afterEach(cleanupTemporaryState);

it.each(['before_link', 'after_link'] as const)(
  'preserves the publication boundary across process interruption %s',
  async (phase) => {
    const directory = await makeTempDir();
    const output = path.join(directory, 'corpus.jsonl');
    const event = createAuditEvent(
      {
        id: 'e',
        sessionId: 's',
        sequence: 1,
        eventType: 'session_started',
        recordedAt: '2026-11-14T17:00:00.000Z',
        stateVersion: 0,
        previousSha256: ZERO_AUDIT_HASH,
        payload: { task_id: 't', lifecycle_state: 'queued' },
      },
      sha256,
    );
    const corpus = createAuditCorpus([{ session_id: 's', events: [event] }], sha256);
    const script = `
    import * as fs from 'node:fs/promises';
    import { pathToFileURL } from 'node:url';
    const { writeAuditExportExclusive } = await import(pathToFileURL(process.argv[4]).href);
    const pause = async () => { process.send('paused'); await new Promise(resolve => process.once('message', resolve)); };
    await writeAuditExportExclusive(process.argv[1], process.argv[3], {
      ...fs,
      link: async (...args) => { if (process.argv[2] === 'before_link') await pause(); await fs.link(...args); },
      rm: async (...args) => { if (process.argv[2] === 'after_link') await pause(); await fs.rm(...args); },
    });
  `;
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        script,
        output,
        phase,
        corpus.content,
        path.resolve('src/adapters/fs/audit-export.ts'),
      ],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    );
    let stderr = '';
    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    try {
      await Promise.race([
        once(child, 'message'),
        once(child, 'exit').then(() => {
          throw new Error(`Publisher exited before failpoint: ${stderr}`);
        }),
      ]);
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      if (phase === 'before_link') await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
      else expect(verifyAuditCorpus(await readFile(output, 'utf8'), sha256, corpus.root).valid).toBe(true);
      expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toHaveLength(1);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
    }
  },
);
