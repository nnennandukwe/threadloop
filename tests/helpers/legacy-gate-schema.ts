import { readFile } from 'node:fs/promises';
import { closeSqliteConnections } from '../../src/adapters/fs/sqlite-store.js';
import { withStateDb, withTriggersDisabled } from './state-db.js';

/** Replace only the receipt storage with the SQL shipped before catalog adoption. */
export async function installLegacyGateSchema(repoDir: string, generation: 7 | 8) {
  const ddl = await readFile(new URL(`../fixtures/storage-v${generation}-gate-receipts.sql`, import.meta.url), 'utf8');
  closeSqliteConnections(repoDir);
  withStateDb(
    repoDir,
    (db) => {
      const index = db
        .prepare("SELECT sql FROM sqlite_schema WHERE name = 'gate_receipts_session_gate_sequence_idx'")
        .get() as { sql: string };
      db.exec('DROP TRIGGER IF EXISTS gate_receipts_validate_result');
      withTriggersDisabled(db, 'gate_receipts', () => {
        db.exec(`
        DROP INDEX gate_receipts_session_gate_sequence_idx;
        ALTER TABLE gate_receipts RENAME TO fixture_receipts;
        ${ddl}
        INSERT INTO gate_receipts SELECT * FROM fixture_receipts;
        DROP TABLE fixture_receipts;
        DROP TABLE IF EXISTS gate_result_catalog;
        ${index.sql};
      `);
      });
      db.prepare("UPDATE metadata SET value = ? WHERE key = 'schema_version'").run(String(generation));
    },
    { readOnly: false },
  );
}
