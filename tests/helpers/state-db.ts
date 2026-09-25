import path from 'node:path';
import type { SQLInputValue } from 'node:sqlite';
import { DatabaseSync } from '../../src/adapters/fs/sqlite-driver.js';

export function stateDbPath(repoDir: string) {
  return path.join(repoDir, '.threadloop/state/state.db');
}

/**
 * Runs `action` against the repository's state database on a connection of its own, read-only unless asked, and
 * always closes it. The connection is independent of the store's cached ones, so a write here is a concurrent
 * writer from the code under test's point of view.
 */
export function withStateDb<T>(repoDir: string, action: (db: DatabaseSync) => T, { readOnly = true } = {}): T {
  const db = new DatabaseSync(stateDbPath(repoDir), { readOnly });
  try {
    return action(db);
  } finally {
    db.close();
  }
}

/** `SELECT COUNT(*) FROM table WHERE where`, with `params` bound to the `where` placeholders. */
export function countRows(repoDir: string, table: string, where = '1 = 1', ...params: SQLInputValue[]) {
  return withStateDb(
    repoDir,
    (db) =>
      (db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get(...params) as { count: number }).count,
  );
}

/** The single task's lifecycle projection, for fixtures with one session. */
export function readLifecycle(repoDir: string) {
  return withStateDb(
    repoDir,
    (db) => db.prepare(`SELECT status, state_version FROM tasks`).get() as { status: string; state_version: number },
  );
}

/**
 * Drops `table`'s immutability triggers, runs `action`, and recreates them from the exact SQL SQLite stored, so a
 * test can tamper with append-only evidence and still leave the schema the store expects.
 */
export function withTriggersDisabled<T>(db: DatabaseSync, table: string, action: () => T): T {
  const triggers = db
    .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?`)
    .all(table) as Array<{ name: string; sql: string }>;
  for (const { name } of triggers) {
    db.exec(`DROP TRIGGER ${name}`);
  }
  try {
    return action();
  } finally {
    for (const { sql } of triggers) {
      db.exec(sql);
    }
  }
}

/** Rewrites one audit event's stored digest so hash verification fails at `sequence`. */
export function tamperAuditEventHash(repoDir: string, sequence: number) {
  withStateDb(
    repoDir,
    (db) =>
      withTriggersDisabled(db, 'audit_events', () =>
        db.prepare(`UPDATE audit_events SET event_sha256 = ? WHERE sequence = ?`).run('0'.repeat(64), sequence),
      ),
    { readOnly: false },
  );
}

/** Deletes a session's whole audit ledger, genesis included. */
export function deleteAuditLedger(repoDir: string, sessionId: string) {
  withStateDb(
    repoDir,
    (db) =>
      withTriggersDisabled(db, 'audit_events', () =>
        db.prepare(`DELETE FROM audit_events WHERE session_id = ?`).run(sessionId),
      ),
    { readOnly: false },
  );
}
