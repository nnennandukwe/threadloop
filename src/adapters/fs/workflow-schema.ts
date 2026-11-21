import { StateCorruptedError } from '../../contracts/errors.js';
import { DatabaseSync } from './sqlite-driver.js';

const tables = {
  workflow_graphs: `schema_version TEXT NOT NULL, digest TEXT NOT NULL, graph_json TEXT NOT NULL,
    PRIMARY KEY (schema_version, digest)`,
  workflow_runs: `run_id TEXT PRIMARY KEY NOT NULL, schema_version TEXT NOT NULL, graph_digest TEXT NOT NULL,
    genesis_json TEXT NOT NULL, genesis_digest TEXT NOT NULL,
    FOREIGN KEY (schema_version, graph_digest) REFERENCES workflow_graphs(schema_version,digest)`,
  workflow_events: `run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),
    ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 9007199254740991),
    kind TEXT NOT NULL CHECK(kind IN ('create','prepare','apply','admit')), operation_key TEXT NOT NULL,
    secondary_id TEXT, body TEXT NOT NULL, previous TEXT, digest TEXT NOT NULL,
    response_json TEXT NOT NULL, response_sha256 TEXT NOT NULL,
    lifecycle_version INTEGER CHECK(lifecycle_version BETWEEN 0 AND 9007199254740991),
    evidence_revision INTEGER CHECK(evidence_revision BETWEEN 0 AND 9007199254740991),
    CHECK((lifecycle_version IS NOT NULL) = (kind IN ('create','apply'))),
    CHECK((evidence_revision IS NOT NULL) = (kind IN ('create','admit'))),
    CHECK((secondary_id IS NOT NULL) = (kind = 'prepare')),
    UNIQUE(run_id,lifecycle_version), UNIQUE(run_id,evidence_revision),
    PRIMARY KEY (run_id,ordinal), UNIQUE (run_id,kind,operation_key), UNIQUE (kind,secondary_id)`,
  workflow_heads: `run_id TEXT PRIMARY KEY NOT NULL REFERENCES workflow_runs(run_id), state TEXT NOT NULL,
    version INTEGER NOT NULL CHECK(version BETWEEN 0 AND 9007199254740991),
    revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991),
    ordinal INTEGER NOT NULL, digest TEXT NOT NULL,
    FOREIGN KEY (run_id, ordinal) REFERENCES workflow_events(run_id, ordinal)`,
};
const collisions = {
  workflow_graphs: 'schema_version = NEW.schema_version AND digest = NEW.digest',
  workflow_runs: 'run_id = NEW.run_id',
  workflow_events: `(run_id = NEW.run_id AND ordinal = NEW.ordinal)
    OR (run_id = NEW.run_id AND kind = NEW.kind AND operation_key = NEW.operation_key)
    OR (kind = NEW.kind AND secondary_id = NEW.secondary_id)
    OR (run_id = NEW.run_id AND (lifecycle_version = NEW.lifecycle_version OR evidence_revision = NEW.evidence_revision))`,
  workflow_heads: 'run_id = NEW.run_id',
};
const ddl: string[] = [];
for (const table of Object.keys(tables) as (keyof typeof tables)[]) {
  ddl.push(`CREATE TABLE ${table} (${tables[table]}) STRICT, WITHOUT ROWID`);
  for (const [name, clause] of [
    ['no_delete', 'BEFORE DELETE'],
    ['no_update', table === 'workflow_heads' ? 'BEFORE UPDATE OF run_id' : 'BEFORE UPDATE'],
  ]) {
    ddl.push(`CREATE TRIGGER ${table}_${name} ${clause} ON ${table}
      BEGIN SELECT RAISE(ABORT,'immutable workflow record'); END`);
  }
  ddl.push(`CREATE TRIGGER ${table}_no_replace BEFORE INSERT ON ${table}
    WHEN EXISTS (SELECT 1 FROM ${table} WHERE ${collisions[table]})
    BEGIN SELECT RAISE(ABORT,'workflow record already exists'); END`);
}

type Definition = { type: string; name: string; tbl_name: string; sql: string };
function inventory(db: DatabaseSync) {
  return db
    .prepare('SELECT type,name,tbl_name,sql FROM main.sqlite_schema WHERE sql IS NOT NULL')
    .all() as Definition[];
}
const reference = (() => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(ddl.join(';'));
    return new Map(inventory(db).map((record) => [record.name, record]));
  } finally {
    db.close();
  }
})();

function compatibleDefinition(actual: Definition, expected: Definition) {
  if (actual.sql === expected.sql) return true;
  if (expected.type !== 'table') return false;
  // SQLite inserts each ADD COLUMN immediately before the first table-level constraint.
  // Accept only simple nullable additions. The original constraints and flags must still match in full.
  const boundary = expected.sql.search(/,\s*(?:PRIMARY KEY|FOREIGN KEY|CHECK|UNIQUE)\s*\(/i);
  if (boundary < 0) return false;
  const prefix = expected.sql.slice(0, boundary),
    suffix = expected.sql.slice(boundary);
  if (!actual.sql.startsWith(prefix) || !actual.sql.endsWith(suffix)) return false;
  const additions = actual.sql.slice(prefix.length, actual.sql.length - suffix.length);
  if (!additions.startsWith(',')) return false;
  return additions
    .slice(1)
    .split(',')
    .every((clause) => {
      const fields = clause.trim().toUpperCase().split(/\s+/);
      const [name, type] = fields;
      return (
        !!name &&
        /^(?:[A-Z_][A-Z_0-9]*|"[A-Z_][A-Z_0-9]*")$/.test(name) &&
        !!type &&
        ['TEXT', 'BLOB', 'INTEGER', 'REAL', 'ANY'].includes(type) &&
        (fields.length === 2 || (fields.length === 4 && fields[2] === 'DEFAULT' && fields[3] === 'NULL'))
      );
    });
}

export function workflowSchema(db: DatabaseSync, install = false): boolean {
  const seen = new Set<string>();
  for (const record of inventory(db)) {
    const name = record.name.toLowerCase();
    const expected = reference.get(name);
    if (expected) {
      if (
        seen.has(name) ||
        record.type !== expected.type ||
        !compatibleDefinition(record, expected) ||
        record.tbl_name !== expected.tbl_name ||
        record.name !== expected.name
      ) {
        throw new StateCorruptedError(`Workflow storage has a conflicting definition for ${name}`);
      }
      seen.add(name);
    } else if (
      Object.hasOwn(tables, record.tbl_name.toLowerCase()) &&
      (record.type === 'trigger' || (record.type === 'index' && /^CREATE UNIQUE INDEX/i.test(record.sql)))
    ) {
      throw new StateCorruptedError(`Workflow storage has an unexpected ${record.type}: ${name}`);
    }
  }
  if (seen.size === reference.size) return true;
  if (seen.size) throw new StateCorruptedError('Workflow storage is missing a required table or constraint');
  if (install) db.exec(ddl.join(';'));
  return install;
}
