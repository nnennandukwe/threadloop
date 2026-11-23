import { pathToFileURL } from 'node:url';
import { applyExecutionOperation, projectExecution } from 'threadloop-contracts/execution';
import type { ExecutionAuthority, ExecutionJournal } from 'threadloop-contracts/execution';
import { isPlainObject } from '../../src/domain/canonical-json.js';
import { DatabaseSync } from '../../src/adapters/fs/sqlite-driver.js';
import { readSealedRoot, sealedRootTable, writeSealedRoot } from '../../src/adapters/fs/sealed-root.js';

/** One private scenario journal. Each method opens its own connection. */
export class ScenarioJournal {
  constructor(
    private readonly filename: string,
    private readonly authority: ExecutionAuthority,
  ) {}
  private write<T>(creating: boolean, operation: (database: DatabaseSync) => T): T {
    const file = pathToFileURL(this.filename);
    file.searchParams.set('mode', creating ? 'rwc' : 'rw');
    const database = new DatabaseSync(file.href);
    try {
      database.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL');
      database.exec('BEGIN IMMEDIATE');
      const result = operation(database);
      database.exec('COMMIT');
      return result;
    } finally {
      database.close();
    }
  }
  initialize(journal: ExecutionJournal): void {
    this.write(true, (database) => {
      database.exec(sealedRootTable);
      writeSealedRoot(database, journal);
    });
  }
  apply(context: unknown, operation: unknown) {
    return this.write(false, (database) => {
      const row = readSealedRoot(database);
      const applied = applyExecutionOperation(row.value, context, operation, this.authority);
      if (!applied.ok) return applied;
      if (!isPlainObject(row.value) || row.value.execution_digest !== applied.value.expected_execution_digest)
        throw new Error('Execution proposal differs from the retained predecessor.');
      if (!applied.value.replayed) writeSealedRoot(database, applied.value.journal, row.digest);
      return applied;
    });
  }
  project(snapshot: unknown) {
    const database = new DatabaseSync(this.filename, { readOnly: true });
    try {
      database.exec('PRAGMA busy_timeout=5000');
      return projectExecution(readSealedRoot(database).value, snapshot, this.authority);
    } finally {
      database.close();
    }
  }
}
