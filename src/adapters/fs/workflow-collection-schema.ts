import type { DatabaseSync } from './sqlite-driver.js';
import { StateCorruptedError } from '../../contracts/errors.js';

const definitions = {
  workflow_collection_events: `CREATE TABLE workflow_collection_events (
  run_id TEXT NOT NULL REFERENCES workflow_runs(run_id), key TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 2),
  phase TEXT NOT NULL CHECK(phase IN ('intent','captured','completed','failed')),body TEXT NOT NULL,digest TEXT NOT NULL,
  PRIMARY KEY(run_id,key,ordinal),UNIQUE(run_id,key,phase)) STRICT`,
  workflow_collection_no_update: `CREATE TRIGGER workflow_collection_no_update BEFORE UPDATE ON workflow_collection_events BEGIN SELECT RAISE(ABORT,'immutable workflow collection'); END`,
  workflow_collection_no_delete: `CREATE TRIGGER workflow_collection_no_delete BEFORE DELETE ON workflow_collection_events BEGIN SELECT RAISE(ABORT,'immutable workflow collection'); END`,
  workflow_collection_no_replace: `CREATE TRIGGER workflow_collection_no_replace BEFORE INSERT ON workflow_collection_events WHEN EXISTS(
 SELECT 1 FROM workflow_collection_events WHERE run_id=NEW.run_id AND key=NEW.key AND (phase=NEW.phase OR ordinal=NEW.ordinal))
 BEGIN SELECT RAISE(ABORT,'duplicate workflow collection'); END`,
};

export function ensureWorkflowCollectionSchema(db: DatabaseSync, create = false): void {
  const objects = db
    .prepare("SELECT name,sql FROM sqlite_schema WHERE tbl_name='workflow_collection_events' AND sql IS NOT NULL")
    .all();
  if (!objects.length && create) {
    for (const sql of Object.values(definitions)) db.exec(sql);
    return;
  }
  if (objects.length !== Object.keys(definitions).length)
    throw new StateCorruptedError('The managed evidence collection has an unexpected schema object.');
  const declarations = new Map(objects.map((row) => [row.name, row.sql]));
  for (const [name, sql] of Object.entries(definitions))
    if (declarations.get(name) !== sql)
      throw new StateCorruptedError('The managed evidence collection schema is missing or damaged.');
}
