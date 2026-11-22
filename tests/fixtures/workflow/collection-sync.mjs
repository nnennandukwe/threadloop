// Observe real syncs in the collecting CLI and inject one requested filesystem error.
import { appendFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';

const trace = process.env.THREADLOOP_TEST_GATE_SYNC_TRACE;
if (trace && process.argv.slice(2, 6).join(' ') === 'workflow evidence collect local-gate') {
  const open = fsPromises.open;
  fsPromises.open = async (file, ...args) => {
    const handle = await open(file, ...args);
    if (typeof file !== 'string') return handle;
    const name = path.relative(process.cwd(), file) || '.';
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      if (name === process.env.THREADLOOP_TEST_GATE_SYNC_FAILURE) {
        appendFileSync(trace, JSON.stringify({ name, result: 'injected EIO' }) + '\n');
        throw Object.assign(new Error('The test refused to sync the gate artifact.'), { code: 'EIO' });
      }
      await sync();
      appendFileSync(trace, JSON.stringify({ name, result: 'synced' }) + '\n');
    };
    return handle;
  };
  syncBuiltinESMExports();
}
