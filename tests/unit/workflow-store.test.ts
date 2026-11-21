import { access, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../../src/domain/canonical-json.js';
import { workflowDigest } from '../../src/domain/workflow-selection-types.js';
import { prepareWorkflowGenesis } from '../../src/services/workflow-genesis.js';
import { DatabaseSync } from '../../src/adapters/fs/sqlite-driver.js';
import { threadloopPaths } from '../../src/adapters/fs/repo.js';
import { decideWorkflow, observeWorkflow, applyWorkflow } from '../../src/services/workflow-evaluation.js';
import { prepareSensorObservation } from '../../src/services/workflow-preparation.js';
import { governedProfile, governedWorkflowFixture } from '../helpers/workflow-run.js';
import type { PrepareTarget } from '../../src/domain/workflow-run.js';
import { afterEach, expect, it } from 'vitest';
import { closeSqliteConnections, ensureStateDatabase, withReadSnapshot } from '../../src/adapters/fs/sqlite-store.js';
import { createWorkflowStore } from '../../src/adapters/fs/workflow-store.js';
import { cleanupTemporaryState, makeCommittedRepo, makeTempDir } from '../helpers/session.js';

afterEach(cleanupTemporaryState);

it('reads an initialized generation-8 repository without adopting workflow tables', async () => {
  const root = await makeTempDir('workflow-store-');
  await ensureStateDatabase(root);
  closeSqliteConnections(root);
  const inventory = () =>
    withReadSnapshot(root, (db) => db.prepare('SELECT type, name, sql FROM sqlite_schema ORDER BY name').all());
  const before = inventory();
  expect(() => createWorkflowStore(root).read('parcel-proof')).toThrowError(
    expect.objectContaining({ code: 'WORKFLOW_RUN_NOT_FOUND' }),
  );
  expect(inventory()).toEqual(before);
});

const profile = fileURLToPath(new URL('../fixtures/workflow/quote.yaml', import.meta.url));
const at = '2026-11-21T00:00:00.000Z';
const run = 'parcel-proof';

async function repository() {
  const root = await makeTempDir('workflow-store-');
  const subject = await makeCommittedRepo({ branch: 'quote', remote: null });
  await ensureStateDatabase(root);
  await writeFile(
    path.join(root, 'setup.json'),
    JSON.stringify({
      schema_version: 'threadloop.workflow-setup/1',
      subject_workspace: subject,
      repository_id: 'parcel',
      policy: {
        id: 'local',
        proof_binding_transition_id: null,
        local_gate_ids: [],
        independent_gate_ids: [],
        publication_destination: null,
      },
      proof_plan: null,
      trusted_sources: null,
      allowed_change_paths: [],
    }),
  );
  const genesis = prepareWorkflowGenesis(root, run, profile, 'setup.json');
  return { root, requestJson: genesis.requestJson, build: (now: string) => genesis.build(now) };
}

it('commits genesis once and recovers the original create result after reopening', async () => {
  const { root, requestJson, build } = await repository();
  const store = createWorkflowStore(root, () => at);
  const created = store.create(run, requestJson, build);
  expect(created).toMatchObject({ state: 'intake', state_version: 0, evidence_revision: 0 });
  closeSqliteConnections(root);
  const reopened = createWorkflowStore(root);
  expect(reopened.read(run).view).toEqual(created);
  const lostResponseRetry = () => {
    throw new Error('reobserved an already committed create');
  };
  expect(reopened.create(run, requestJson, lostResponseRetry)).toEqual(created);
  expect(() => reopened.create(run, '{}', lostResponseRetry)).toThrowError(
    expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }),
  );
});

it('reads and writes the supported columns after a nullable column is added', async () => {
  const { root, requestJson, build } = await repository();
  const store = createWorkflowStore(root, () => at);
  const view = store.create(run, requestJson, build);
  const db = new DatabaseSync(threadloopPaths(root).stateDbPath);
  try {
    for (const table of ['workflow_graphs', 'workflow_runs', 'workflow_events', 'workflow_heads']) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN annotation TEXT DEFAULT NULL`);
    }
  } finally {
    db.close();
  }
  const snapshot = store.read(run);
  expect(snapshot.view).toEqual(view);
  const decision = decideWorkflow(snapshot, observeWorkflow(snapshot), at);
  const apply = () => store.apply(run, 'move', decision, (snap, now) => applyWorkflow(snap, decision, now));
  const first = apply();
  expect(first).toMatchObject({ from: 'intake', to: 'prepared', state_version: 1 });
  expect(apply()).toEqual(first);
  expect(store.create(run, requestJson, build)).toEqual(view);
});

it.each(['7', '9', '8x'])('preserves unsupported generation %s before opening a run', async (generation) => {
  const { root, requestJson, build } = await repository();
  const db = new DatabaseSync(threadloopPaths(root).stateDbPath);
  try {
    db.prepare("UPDATE metadata SET value=? WHERE key='schema_version'").run(generation);
    const inventory = () => db.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all();
    const before = inventory(),
      store = createWorkflowStore(root, () => at);
    expect(() => store.create(run, requestJson, build)).toThrowError(
      expect.objectContaining({ code: 'STATE_CORRUPTED' }),
    );
    expect(() => store.read(run)).toThrowError(expect.objectContaining({ code: 'STATE_CORRUPTED' }));
    expect(inventory()).toEqual(before);
  } finally {
    db.close();
  }
});

it('opens only existing storage and rolls back schema adoption on a rejected async callback', async () => {
  const root = await makeTempDir('workflow-store-');
  const store = createWorkflowStore(root, () => at);
  const never = () => {
    throw new Error('callback should not run');
  };
  expect(() => store.create(run, '{}', never)).toThrowError(
    expect.objectContaining({ code: 'THREADLOOP_NOT_INITIALIZED' }),
  );
  await expect(access(threadloopPaths(root).stateDbPath)).rejects.toMatchObject({ code: 'ENOENT' });
  await ensureStateDatabase(root);
  const asyncBuild = (() => Promise.resolve({})) as unknown as Parameters<typeof store.create>[2];
  expect(() => store.create(run, '{}', asyncBuild)).toThrow(/synchronously/);
  expect(
    withReadSnapshot(root, (db) => db.prepare("SELECT name FROM sqlite_schema WHERE name GLOB 'workflow_*'").all()),
  ).toEqual([]);
});

it('rejects an occupied table name and a same-name trigger with a different body', async () => {
  const { root, requestJson, build } = await repository(),
    store = createWorkflowStore(root, () => at);
  const db = new DatabaseSync(threadloopPaths(root).stateDbPath);
  try {
    db.exec('CREATE TABLE Workflow_Graphs(schema_version TEXT, digest TEXT, graph_json TEXT)');
    expect(() => store.create(run, requestJson, build)).toThrowError(
      expect.objectContaining({ code: 'STATE_CORRUPTED' }),
    );
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'workflow_%'").all()).toEqual([
      { name: 'Workflow_Graphs' },
    ]);
    db.exec('DROP TABLE Workflow_Graphs');
    store.create(run, requestJson, build);
    db.exec(
      'DROP TRIGGER workflow_events_no_update; CREATE TRIGGER workflow_events_no_update BEFORE UPDATE ON workflow_events WHEN 0 BEGIN SELECT 1; END',
    );
    expect(() => store.read(run)).toThrowError(expect.objectContaining({ code: 'STATE_CORRUPTED' }));
    expect(() => store.create(run, requestJson, build)).toThrowError(
      expect.objectContaining({ code: 'STATE_CORRUPTED' }),
    );
  } finally {
    db.close();
  }
});

it.each(['product first', 'instruction first'])(
  'keeps product and instruction pull requests separate, %s',
  async (order) => {
    const run = 'session_wf_parcel';
    const { control } = await governedWorkflowFixture();
    await ensureStateDatabase(control);
    const genesis = prepareWorkflowGenesis(control, run, governedProfile, 'setup.json');
    const store = createWorkflowStore(control, () => at);
    const original = store.create(run, genesis.requestJson, (now) => genesis.build(now));
    const product: PrepareTarget = { kind: 'signed-review', pr: 41 };
    const instruction: PrepareTarget = {
      kind: 'signed-instruction',
      pr: 41,
      instruction: { purpose: 'request_stop', reason: 'Operator request' },
    };
    const [first, other] = order === 'product first' ? [product, instruction] : [instruction, product];
    const prepare = (key: string, target: PrepareTarget) =>
      store.prepare(run, key, 0, target, (snap, id, now) =>
        prepareSensorObservation(snap, observeWorkflow(snap), target, id, now),
      );
    const one = prepare('enroll', first);
    expect(prepare('enroll', first)).toEqual(one);
    expect(() => prepare('another', other)).toThrowError(expect.objectContaining({ code: 'TRANSITION_GUARD_FAILED' }));
    const snapshot = store.read(run);
    expect(snapshot.observations).toEqual([]);
    expect(snapshot.view).toEqual(original);
  },
);

it('refuses replay if the original response bytes are lost or changed', async () => {
  const { root, requestJson, build } = await repository();
  const store = createWorkflowStore(root, () => at);
  store.create(run, requestJson, build);
  const db = new DatabaseSync(threadloopPaths(root).stateDbPath);
  try {
    const trigger = String(
      db.prepare("SELECT sql FROM sqlite_schema WHERE name='workflow_events_no_update'").get()?.sql,
    );
    db.exec('DROP TRIGGER workflow_events_no_update');
    db.prepare("UPDATE workflow_events SET response_json='{}' WHERE run_id=?").run(run);
    db.exec(trigger);
    expect(() => store.create(run, requestJson, build)).toThrowError(
      expect.objectContaining({ code: 'STATE_CORRUPTED' }),
    );
  } finally {
    db.close();
  }
});

it('protects immutable records, including conflicting inserts on a secondary key', async () => {
  const { root, requestJson, build } = await repository();
  const store = createWorkflowStore(root, () => at);
  const view = store.create(run, requestJson, build);
  const db = new DatabaseSync(threadloopPaths(root).stateDbPath);
  try {
    db.exec('PRAGMA recursive_triggers=OFF');
    expect(() => db.prepare('DELETE FROM workflow_graphs WHERE digest=?').run(view.graph_digest)).toThrow(/immutable/);
    expect(() => db.prepare("UPDATE workflow_runs SET graph_digest='altered' WHERE run_id=?").run(run)).toThrow(
      /immutable/,
    );
    expect(() => db.prepare('UPDATE workflow_heads SET run_id=run_id WHERE run_id=?').run(run)).toThrow(/immutable/);
    // This insert uses a new ordinal and operation key, but it reuses version zero.
    expect(() =>
      db
        .prepare(
          `INSERT OR REPLACE INTO workflow_events (run_id,ordinal,kind,operation_key,body,digest,lifecycle_version,response_json,response_sha256)
      VALUES (?,9,'apply','reused_version','{}','other',0,'{}','other')`,
        )
        .run(run),
    ).toThrow(/already exists/);
    expect(store.read(run).view).toEqual(view);
  } finally {
    db.close();
  }
});

it('refuses a cached writer after its initialized database file moves', async () => {
  const { root, requestJson, build } = await repository();
  const dbPath = threadloopPaths(root).stateDbPath;
  await rename(dbPath, dbPath + '.saved');
  const store = createWorkflowStore(root, () => at);
  expect(() => store.create(run, requestJson, build)).toThrowError(
    expect.objectContaining({ code: 'THREADLOOP_NOT_INITIALIZED' }),
  );
  await expect(access(dbPath)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('refuses mismatched or missing graph bytes before any replay', async () => {
  const { root, requestJson, build } = await repository();
  const store = createWorkflowStore(root, () => at);
  const created = store.create(run, requestJson, build);
  const db = new DatabaseSync(threadloopPaths(root).stateDbPath, { enableForeignKeyConstraints: false });
  try {
    for (const [guard, mutation] of [
      ['workflow_graphs_no_update', "UPDATE workflow_graphs SET graph_json='{}' WHERE digest=?"],
      ['workflow_graphs_no_delete', 'DELETE FROM workflow_graphs WHERE digest=?'],
    ] as const) {
      const definition = String(db.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(guard)?.sql);
      db.exec(`DROP TRIGGER ${guard}`);
      db.prepare(mutation).run(created.graph_digest);
      db.exec(definition);
      expect(() => store.read(run)).toThrowError(expect.objectContaining({ code: 'STATE_CORRUPTED' }));
      expect(() => store.create(run, requestJson, build)).toThrowError(
        expect.objectContaining({ code: 'STATE_CORRUPTED' }),
      );
    }
  } finally {
    db.close();
  }
});

it('isolates an opaque future setup from v1 runs in the same database', async () => {
  const { root, requestJson, build } = await repository();
  const store = createWorkflowStore(root, () => at);
  const v1 = store.create(run, requestJson, build);
  const genesis = store.read(run).genesis;
  const db = new DatabaseSync(threadloopPaths(root).stateDbPath);
  try {
    // Model the unchanged v1 storage envelope around opaque bytes from a newer writer.
    for (const [id, valid] of [
      ['future-run', true],
      ['damaged-run', false],
    ] as const) {
      const setup = { ...genesis.setup, schema_version: 'threadloop.workflow-setup/3' };
      const retained = { ...genesis, run_id: id, setup, setup_sha256: valid ? workflowDigest(setup) : '0'.repeat(64) };
      const genesisDigest = workflowDigest(retained);
      const request = canonicalJson({ ...(JSON.parse(requestJson) as Record<string, unknown>), run: id, setup });
      const body = canonicalJson({ kind: 'create', genesis_digest: genesisDigest, request });
      const header = {
        run_id: id,
        ordinal: 0,
        previous: null,
        kind: 'create',
        operation_key: id,
        secondary_id: null,
        lifecycle_version: 0,
        evidence_revision: 0,
        body,
      };
      const digest = workflowDigest(header);
      const reply = { ...v1, workflow_run_id: id, history_digest: digest };
      db.prepare(
        'INSERT INTO workflow_runs (run_id,schema_version,graph_digest,genesis_json,genesis_digest) VALUES (?,?,?,?,?)',
      ).run(id, '0.1', v1.graph_digest, canonicalJson(retained), genesisDigest);
      db.prepare(
        `INSERT INTO workflow_events
        (run_id,ordinal,previous,kind,operation_key,secondary_id,lifecycle_version,evidence_revision,body,digest,response_json,response_sha256)
        VALUES (?,0,NULL,'create',?,NULL,0,0,?,?,?,?)`,
      ).run(id, id, body, digest, canonicalJson(reply), workflowDigest(reply));
      db.prepare('INSERT INTO workflow_heads (run_id,state,version,revision,ordinal,digest) VALUES (?,?,0,0,0,?)').run(
        id,
        v1.state,
        digest,
      );
    }
    expect(() => store.read('future-run')).toThrowError(
      expect.objectContaining({ code: 'WORKFLOW_RUNTIME_UNSUPPORTED' }),
    );
    expect(() => store.read('damaged-run')).toThrowError(expect.objectContaining({ code: 'STATE_CORRUPTED' }));
    expect(store.read(run).view).toEqual(v1);
  } finally {
    db.close();
  }
});
