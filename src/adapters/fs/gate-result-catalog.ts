import { StateCorruptedError } from '../../contracts/errors.js';
import { sha256 } from '../crypto/sha256.js';
import { GATE_RECEIPT_RESULTS } from '../../domain/proof.js';
import type { DatabaseSync } from './sqlite-driver.js';

export const GATE_RECEIPTS_TABLE = `CREATE TABLE IF NOT EXISTS gate_receipts (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      gate_id TEXT NOT NULL,
      plan_sha256 TEXT NOT NULL CHECK(length(plan_sha256) = 64),
      head_before TEXT NOT NULL,
      head_after TEXT NOT NULL,
      result TEXT NOT NULL REFERENCES gate_result_catalog(value),
      artifact_path TEXT NOT NULL,
      artifact_sha256 TEXT NOT NULL CHECK(length(artifact_sha256) = 64),
      receipt_json TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL CHECK(length(receipt_sha256) = 64),
      state_version INTEGER NOT NULL CHECK(state_version >= 0),
      created_at TEXT NOT NULL
    )`;

export const GATE_RECEIPT_SEQUENCE_INDEX = `CREATE INDEX IF NOT EXISTS gate_receipts_session_gate_sequence_idx
      ON gate_receipts(session_id, gate_id, sequence DESC)`;

const catalogDefinitions = {
  gate_result_catalog: 'CREATE TABLE gate_result_catalog (value TEXT NOT NULL PRIMARY KEY)',
  gate_result_catalog_no_update: `CREATE TRIGGER gate_result_catalog_no_update BEFORE UPDATE ON gate_result_catalog
    BEGIN SELECT RAISE(ABORT, 'gate result catalog entries are immutable'); END`,
  gate_result_catalog_no_delete: `CREATE TRIGGER gate_result_catalog_no_delete BEFORE DELETE ON gate_result_catalog
    BEGIN SELECT RAISE(ABORT, 'gate result catalog entries are immutable'); END`,
  gate_result_catalog_no_replace: `CREATE TRIGGER gate_result_catalog_no_replace BEFORE INSERT ON gate_result_catalog
    WHEN EXISTS (SELECT 1 FROM gate_result_catalog WHERE value = NEW.value)
    BEGIN SELECT RAISE(ABORT, 'gate result catalog entries are immutable'); END`,
  gate_receipts_validate_result: `CREATE TRIGGER gate_receipts_validate_result BEFORE INSERT ON gate_receipts
    WHEN NOT EXISTS (SELECT 1 FROM gate_result_catalog WHERE value = NEW.result)
    BEGIN SELECT RAISE(ABORT, 'unknown gate receipt result'); END`,
};

const OLD_RECEIPTS = 'gate_receipts_pre_setup_result_domain';
// Fingerprints of SQLite's stored ASCII DDL, including the final closing parenthesis.
// The original definitions live in tests/fixtures/storage-v*-gate-receipts.sql.
const legacyReceiptTables = new Map([
  [7, { length: 826, sha256: 'e0a2bcb53b325530ea5ba84fffaf483bcae745852bf25b5853900819c22e3495' }],
  [8, { length: 842, sha256: '6aee68d43662104b35241a74cd1afc16fccb2d6477d8def918cfd9560fd60876' }],
]);

function storedSql(db: DatabaseSync, name: string) {
  const row = db.prepare('SELECT sql FROM sqlite_schema WHERE name = ? COLLATE NOCASE').get(name) as
    { sql: string | null } | undefined;
  return row?.sql;
}

// ALTER TABLE ADD COLUMN appends its declaration just before the final parenthesis.
function matchesTablePrefix(actual: string, expected: string) {
  return actual === expected || actual.startsWith(expected.slice(0, -1) + ',');
}

export function gateReceiptLayout(
  db: DatabaseSync,
  generation: number,
  operation: 'read' | 'write',
): 'legacy' | 'catalog' {
  const sql = storedSql(db, 'gate_receipts');
  const legacy = legacyReceiptTables.get(generation);
  if (sql && legacy) {
    // ADD COLUMN inserts a comma at the original closing parenthesis. A reader can verify the entire shipped
    // definition without parsing the added declarations. A writer can only rebuild the exact historical table.
    const end = legacy.length - 1;
    const extended = operation === 'read' && sql[end] === ',';
    if (
      (extended || sql.length === legacy.length) &&
      sha256(extended ? sql.slice(0, end) + ')' : sql) === legacy.sha256
    ) {
      return 'legacy';
    }
  }
  if (!sql || !matchesTablePrefix(sql, GATE_RECEIPTS_TABLE.replace(' IF NOT EXISTS', ''))) {
    throw new StateCorruptedError(
      'Unrecognized gate_receipts schema. Preserve the database and inspect the stored definition before retrying.',
    );
  }
  for (const [name, expected] of Object.entries(catalogDefinitions)) {
    const actual = storedSql(db, name);
    if (!actual || !(name === 'gate_result_catalog' ? matchesTablePrefix(actual, expected) : actual === expected)) {
      throw new StateCorruptedError(
        `Invalid schema for ${name}. Restore the gate result catalog and its protections from trusted storage.`,
      );
    }
  }
  return 'catalog';
}

export function createGateResultCatalog(db: DatabaseSync) {
  for (const ddl of Object.values(catalogDefinitions)) db.exec(ddl);
  seedGateResults(db);
}

export function detachLegacyGateReceipts(db: DatabaseSync) {
  for (const name of [OLD_RECEIPTS, ...Object.keys(catalogDefinitions)]) {
    if (storedSql(db, name) !== undefined) {
      throw new StateCorruptedError(
        `Can't adopt gate receipts while ${name} already exists. Inspect the conflicting object before retrying.`,
      );
    }
  }
  // A rebuild can't discard custom indexes, triggers or other features attached to this table.
  const drops = new Map([
    ['gate_receipts_no_update', 'DROP TRIGGER gate_receipts_no_update'],
    ['gate_receipts_no_delete', 'DROP TRIGGER gate_receipts_no_delete'],
    ['gate_receipts_no_replace', 'DROP TRIGGER gate_receipts_no_replace'],
    ['gate_receipts_session_gate_sequence_idx', 'DROP INDEX gate_receipts_session_gate_sequence_idx'],
  ]);
  const objects = db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE tbl_name = 'gate_receipts' AND type IN ('index','trigger') AND sql IS NOT NULL",
    )
    .all() as Array<{ name: string }>;
  for (const { name } of objects) {
    if (!drops.has(name))
      throw new StateCorruptedError(
        `Can't rebuild gate_receipts with unrecognized object ${name}. Preserve it before retrying.`,
      );
  }
  if (
    storedSql(db, 'gate_receipts_session_gate_sequence_idx') !==
    GATE_RECEIPT_SEQUENCE_INDEX.replace(' IF NOT EXISTS', '')
  ) {
    throw new StateCorruptedError('Unrecognized gate receipt sequence index. Preserve the index before retrying.');
  }
  for (const [name, drop] of drops) {
    if (!objects.some((object) => object.name === name))
      throw new StateCorruptedError(`Invalid schema for gate_receipts: missing ${name}.`);
    db.exec(drop);
  }
  // SQLite rewrites references in other tables, views and triggers during a rename.
  // Compare their stored definitions across that operation while the write lock is held.
  const externalObjects = db.prepare(
    'SELECT type, name, sql FROM main.sqlite_schema WHERE tbl_name <> ? AND sql IS NOT NULL ORDER BY type, name',
  );
  const before = externalObjects.all('gate_receipts');
  db.exec(`ALTER TABLE gate_receipts RENAME TO ${OLD_RECEIPTS}`);
  const after = externalObjects.all(OLD_RECEIPTS);
  const dependent = before.find((object, index) => object.sql !== after[index]?.sql);
  if (dependent)
    throw new StateCorruptedError(
      `Can't rebuild gate_receipts while ${String(dependent.name)} refers to it. Preserve the dependent schema before retrying.`,
    );
}

export function restoreLegacyGateReceipts(db: DatabaseSync) {
  const columns = [
    'sequence',
    'id',
    'session_id',
    'gate_id',
    'plan_sha256',
    'head_before',
    'head_after',
    'result',
    'artifact_path',
    'artifact_sha256',
    'receipt_json',
    'receipt_sha256',
    'state_version',
    'created_at',
  ];
  const projection = columns.join(', ');
  try {
    db.exec(`INSERT INTO gate_receipts (${projection}) SELECT ${projection} FROM ${OLD_RECEIPTS} ORDER BY sequence`);
  } catch (cause) {
    throw new StateCorruptedError(
      'Failed to copy the historical gate receipts. Inspect their stored constraints before retrying.',
      { cause },
    );
  }
  // Compare one original to its copy by primary key, without materializing the entire receipt archive a third time.
  const differs = columns.map((column) => `source.${column} IS NOT copy.${column}`).join(' OR ');
  const difference = db
    .prepare(
      `SELECT 1 FROM ${OLD_RECEIPTS} source LEFT JOIN gate_receipts copy USING(sequence)
    WHERE ${differs} LIMIT 1`,
    )
    .get();
  if (difference) throw new StateCorruptedError('Gate receipt adoption changed a stored row.');
  // AUTOINCREMENT's high-water mark can exceed the largest stored row after a skipped insert.
  db.exec(`UPDATE sqlite_sequence SET seq = max(seq, coalesce((SELECT seq FROM sqlite_sequence WHERE name = '${OLD_RECEIPTS}'), seq))
    WHERE name = 'gate_receipts';
    DROP TABLE ${OLD_RECEIPTS};`);
}

export function seedGateResults(db: DatabaseSync) {
  const seed = db.prepare(
    'INSERT INTO gate_result_catalog (value) SELECT ? WHERE NOT EXISTS (SELECT 1 FROM gate_result_catalog WHERE value = ?)',
  );
  for (const result of GATE_RECEIPT_RESULTS) seed.run(result, result);
}
