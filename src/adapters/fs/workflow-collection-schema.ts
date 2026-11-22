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

const launchDefinitions = {
  workflow_gate_launches: `CREATE TABLE workflow_gate_launches (
  run_id TEXT NOT NULL, key TEXT NOT NULL, intent_ordinal INTEGER NOT NULL DEFAULT 0 CHECK(intent_ordinal=0),
  attempt TEXT NOT NULL UNIQUE, intent_digest TEXT NOT NULL, claimed INTEGER NOT NULL CHECK(claimed IN (0,1)),
  PRIMARY KEY(run_id,key),FOREIGN KEY(run_id,key,intent_ordinal) REFERENCES workflow_collection_events(run_id,key,ordinal)) STRICT`,
  workflow_gate_launches_no_delete: `CREATE TRIGGER workflow_gate_launches_no_delete BEFORE DELETE ON workflow_gate_launches BEGIN SELECT RAISE(ABORT,'immutable gate launch reservation'); END`,
  workflow_gate_launches_no_replace: `CREATE TRIGGER workflow_gate_launches_no_replace BEFORE INSERT ON workflow_gate_launches
  WHEN NEW.claimed<>0 OR EXISTS(SELECT 1 FROM workflow_gate_launches WHERE (run_id=NEW.run_id AND key=NEW.key) OR attempt=NEW.attempt)
  BEGIN SELECT RAISE(ABORT,'invalid or duplicate gate launch reservation'); END`,
  workflow_gate_launches_claim_once: `CREATE TRIGGER workflow_gate_launches_claim_once BEFORE UPDATE ON workflow_gate_launches
  WHEN OLD.claimed<>0 OR NEW.claimed<>1 OR NEW.run_id<>OLD.run_id OR NEW.key<>OLD.key OR NEW.attempt<>OLD.attempt
    OR NEW.intent_ordinal<>OLD.intent_ordinal OR NEW.intent_digest<>OLD.intent_digest
  BEGIN SELECT RAISE(ABORT,'gate launch authority can be claimed only once'); END`,
};

export function requireGateLaunchSchema(db: DatabaseSync, install = false): void {
  const rows = db
    .prepare("SELECT name,sql FROM sqlite_schema WHERE tbl_name='workflow_gate_launches' AND sql IS NOT NULL")
    .all();
  if (!rows.length && install) {
    const prior = db
      .prepare(
        "SELECT 1 FROM workflow_collection_events WHERE phase='intent' AND json_type(body,'$.intent.launch_protocol') IS NOT NULL LIMIT 1",
      )
      .get();
    if (!prior) {
      for (const sql of Object.values(launchDefinitions)) db.exec(sql);
      return;
    }
  }
  const declarations = new Map(rows.map((row) => [row.name, row.sql]));
  if (
    rows.length !== Object.keys(launchDefinitions).length ||
    Object.entries(launchDefinitions).some(([name, sql]) => declarations.get(name) !== sql)
  )
    throw new StateCorruptedError(
      'The managed gate launch ledger is missing or damaged. Restore the original control database before retrying.',
    );
}
