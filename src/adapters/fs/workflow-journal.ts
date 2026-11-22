import { validateGraphBinding } from 'threadloop-contracts/workflow';
import { StateCorruptedError, ThreadloopError } from '../../contracts/errors.js';
import { canonicalJson } from '../../domain/canonical-json.js';
import { workflowDigest } from '../../domain/workflow-selection-types.js';
import { validateWorkflowPreparation } from '../../services/workflow-preparation.js';
import { validateWorkflowGenesis, workflowCreateRequestJson } from '../../services/workflow-genesis.js';
import { applyObservedWorkflow, initialWorkflowHistory } from '../../services/workflow-evaluation.js';
import type {
  AdmissionReply,
  PhysicalObservation,
  ApplyReply,
  Batch,
  DecisionReply,
  Preparation,
  PrepareTarget,
  RunSnapshot,
  RunView,
  WorkflowGenesis,
} from '../../domain/workflow-run.js';
import { demand, equal } from './workflow-storage-checks.js';
import { sha256 } from '../crypto/sha256.js';
import type { DatabaseSync } from './sqlite-driver.js';
import { restoreSource, type SourceRecord, projectAdmission } from './workflow-stored-source.js';
import { executionReader, initialExecution, persistInitialExecution } from './workflow-execution-journal.js';

export { expectVersion } from './workflow-storage-checks.js';

type Content = (
  | { kind: 'create'; request: string; genesis_digest: string }
  | { kind: 'prepare'; version: number; target: PrepareTarget; prepared: Preparation }
  | { kind: 'admit'; source: SourceRecord; batch: Batch; at: string }
  | {
      kind: 'apply';
      proposal: DecisionReply;
      at: string;
      observed: PhysicalObservation;
      fresh_decision_digest: string;
    }
) & { execution_head?: { revision: number; digest: string } };
interface Entry {
  run_id: string;
  ordinal: number;
  previous: string | null;
  kind: Content['kind'];
  operation_key: string;
  secondary_id: string | null;
  lifecycle_version: number | null;
  evidence_revision: number | null;
  body: string;
  digest: string;
}
interface Head {
  state: string;
  version: number;
  revision: number;
  ordinal: number;
  digest: string;
}
interface Index {
  create: { request: string; reply: RunView };
  preparations: Map<string, { version: number; target: PrepareTarget; prepared: Preparation }>;
  byId: Map<string, Preparation>;
  instructions: Set<number>;
  admissions: Map<string, { record: SourceRecord; reply: AdmissionReply }>;
  applies: Map<string, { proposal: DecisionReply; reply: ApplyReply }>;
  sequence: number;
  states: string[];
}
export interface Journal {
  snapshot: RunSnapshot;
  head: Head;
  index: Index;
}

function checkedJson<T>(text: string): T {
  const parsed: unknown = JSON.parse(text);
  demand(canonicalJson(parsed) === text, 'record bytes differ from their canonical encoding');
  return parsed as T;
}
function entry(run: string, prior: Head | null, key: string, content: Content, second: string | null = null): Entry {
  const fields = {
    run_id: run,
    ordinal: prior ? prior.ordinal + 1 : 0,
    previous: prior?.digest ?? null,
    kind: content.kind,
    operation_key: key,
    secondary_id: second,
    lifecycle_version: content.kind === 'create' ? 0 : content.kind === 'apply' ? prior!.version + 1 : null,
    evidence_revision: content.kind === 'create' ? 0 : content.kind === 'admit' ? prior!.revision + 1 : null,
    body: canonicalJson(content),
  };
  return { ...fields, digest: workflowDigest(fields) };
}
function projectHead(snapshot: RunSnapshot, row: Entry): Head {
  return {
    state: snapshot.view.state,
    version: snapshot.view.state_version,
    revision: snapshot.view.evidence_revision,
    ordinal: row.ordinal,
    digest: row.digest,
  };
}

function verifyGenesis(row: Entry, g: WorkflowGenesis): Journal {
  const content = checkedJson<Content>(row.body);
  demand(
    content.kind === 'create' &&
      row.ordinal === 0 &&
      row.previous === null &&
      row.secondary_id === null &&
      row.operation_key === g.run_id &&
      row.run_id === g.run_id &&
      content.genesis_digest === workflowDigest(g) &&
      content.request === workflowCreateRequestJson(g),
    'invalid genesis event',
  );
  const view: RunView = {
    contract_version: 1,
    workflow_run_id: g.run_id,
    graph_schema_version: '0.1',
    graph_digest: g.compiled.graph_digest,
    policy: { id: g.policy.id, digest: g.policy.digest },
    state: g.compiled.graph.initial_state,
    state_version: 0,
    evidence_revision: 0,
    history_digest: row.digest,
  };
  const snapshot: RunSnapshot = {
    genesis: g,
    view,
    history: { ...initialWorkflowHistory(g), digest: row.digest },
    last_subject: g.baseline,
    implementation_manifest: null,
    product_pr: null,
    observations: [],
  };
  if (g.setup.schema_version === 'threadloop.workflow-setup/2') {
    snapshot.managed_execution = initialExecution(g.run_id, row.digest);
    snapshot.view = { ...view, execution_revision: 0, execution_digest: snapshot.managed_execution.digest };
  }
  const index: Index = {
    create: { request: content.request, reply: snapshot.view },
    preparations: new Map(),
    byId: new Map(),
    instructions: new Set(),
    admissions: new Map(),
    applies: new Map(),
    sequence: 0,
    states: [view.state],
  };
  return { snapshot, index, head: projectHead(snapshot, row) };
}

function verifyPrepared(journal: Journal, row: Entry, content: Extract<Content, { kind: 'prepare' }>) {
  const { target, prepared, version } = content;
  demand(
    row.secondary_id === prepared.prepared_id &&
      /^wfr_[a-f0-9]{32}$/.test(prepared.prepared_id) &&
      version === journal.snapshot.view.state_version &&
      equal(prepared.target, target),
    'preparation differs from its operation',
  );
  validateWorkflowPreparation(journal.snapshot, prepared);
  if (target.kind !== 'signed-gate') {
    demand(prepared.pull_request?.number === target.pr, 'preparation pull request differs from target');
    if (target.kind === 'signed-review') {
      demand(
        !journal.index.instructions.has(target.pr) &&
          (!journal.snapshot.product_pr || equal(journal.snapshot.product_pr, prepared.pull_request)),
        'product PR differs from the enrolled PR',
      );
      journal.snapshot.product_pr = prepared.pull_request;
    } else {
      demand(journal.snapshot.product_pr?.number !== target.pr, 'instruction PR is the product PR');
      journal.index.instructions.add(target.pr);
    }
  }
  journal.index.byId.set(prepared.prepared_id, prepared);
  journal.index.preparations.set(row.operation_key, { version, target, prepared });
}

function applyAccepted(journal: Journal, row: Entry, content: Extract<Content, { kind: 'apply' }>) {
  const { proposal, observed, at, fresh_decision_digest } = content;
  const { snapshot } = journal;
  demand(row.secondary_id === null, 'unexpected transition identity');
  const applied = applyObservedWorkflow(snapshot, proposal, observed, at);
  demand(applied.fresh_decision_digest === fresh_decision_digest, 'fresh transition digest differs from its event');
  const { selected, next_history: history, implementation_manifest } = applied;
  const reply: ApplyReply = {
    contract_version: 1,
    workflow_run_id: row.run_id,
    graph_digest: snapshot.view.graph_digest,
    transition_id: selected.transition_id,
    from: snapshot.view.state,
    to: selected.target_state,
    previous_version: snapshot.view.state_version,
    state_version: snapshot.view.state_version + 1,
    event_digest: row.digest,
    decision_digest: proposal.controller_decision.decision_digest,
  };
  journal.index.states.push(reply.to);
  snapshot.history = { ...history, digest: row.digest };
  snapshot.implementation_manifest = implementation_manifest;
  snapshot.last_subject = applied.observed.subject;
  snapshot.view = { ...snapshot.view, state: reply.to, state_version: reply.state_version, history_digest: row.digest };
  journal.index.applies.set(row.operation_key, { proposal, reply });
}

function advance(journal: Journal, row: Entry, content: Content) {
  demand(
    content.kind === row.kind && row.previous === journal.head.digest && row.ordinal === journal.head.ordinal + 1,
    'event chain has a gap',
  );
  const exec = journal.snapshot.managed_execution;
  demand(
    exec
      ? equal(content.execution_head, { revision: exec.revision, digest: exec.digest })
      : content.execution_head === undefined,
    'lifecycle event uses a different execution prefix',
  );
  demand(content.kind !== 'apply' || !exec?.active, 'an outstanding execution holds the lifecycle');
  switch (content.kind) {
    case 'create':
      throw new StateCorruptedError('Workflow Run has a second genesis');
    case 'prepare':
      verifyPrepared(journal, row, content);
      break;
    case 'apply':
      applyAccepted(journal, row, content);
      break;
    case 'admit': {
      const source = restoreSource(content.source);
      const { snapshot, index } = journal;
      const prepared = source.preparedId ? index.byId.get(source.preparedId) : null;
      demand(
        row.operation_key === source.key && row.secondary_id === null && (!source.preparedId || prepared),
        'invalid admission identity',
      );
      demand(
        index.states[content.batch.binding.state_version] === content.batch.binding.source_state,
        'admission references a different producer state',
      );
      const accepted = projectAdmission(snapshot, source, prepared ?? null, content.batch, index.sequence, content.at);
      index.sequence += accepted.observation.receipts.length;
      snapshot.observations = [
        ...snapshot.observations.filter((old) => !accepted.sameStream(old)),
        accepted.observation,
      ];
      snapshot.view = { ...snapshot.view, evidence_revision: accepted.reply.evidence_revision };
      index.admissions.set(source.key, { record: content.source, reply: accepted.reply });
      break;
    }
  }
  journal.head = projectHead(journal.snapshot, row);
  demand(
    row.lifecycle_version === (content.kind === 'apply' ? journal.head.version : null) &&
      row.evidence_revision === (content.kind === 'admit' ? journal.head.revision : null),
    'event versions differ from the projection',
  );
}

function checkGraph(g: WorkflowGenesis, graphJson: unknown, version: unknown, digest: unknown) {
  demand(
    graphJson === g.graph_json &&
      g.graph_json === canonicalJson(g.compiled.graph) &&
      sha256(g.graph_json) === digest &&
      validateGraphBinding({ graph_schema_version: version, graph_digest: digest }, g.compiled).ok,
    'graph bytes or binding changed',
  );
  validateWorkflowGenesis(g);
}

export function loadJournal(db: DatabaseSync, run: string): Journal | null {
  const stored = db
    .prepare(
      `SELECT r.*, g.graph_json FROM workflow_runs r LEFT JOIN workflow_graphs g
    ON g.schema_version=r.schema_version AND g.digest=r.graph_digest WHERE r.run_id=?`,
    )
    .get(run);
  if (!stored) {
    const ledgers = [
      'workflow_heads',
      'workflow_events',
      'workflow_execution_heads',
      'workflow_execution_events',
      'workflow_collection_events',
      'workflow_gate_launches',
    ];
    for (const table of ledgers) {
      if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=? COLLATE NOCASE").get(table)) continue;
      demand(
        db.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name='run_id'").get(table),
        'ledger has no run identity',
      );
      demand(!db.prepare(`SELECT 1 FROM ${table} WHERE run_id=? LIMIT 1`).get(run), 'missing run binding');
    }
    return null;
  }
  let execution: ReturnType<typeof executionReader> | null = null;
  try {
    const genesis = checkedJson<WorkflowGenesis>(String(stored.genesis_json));
    demand(
      genesis.run_id === run && workflowDigest(genesis) === stored.genesis_digest,
      'genesis bytes or run identity changed',
    );
    checkGraph(genesis, stored.graph_json, stored.schema_version, stored.graph_digest);
    if (genesis.gaap) execution = executionReader(db, run);
    const rows = db
      .prepare(
        'SELECT run_id,ordinal,previous,kind,operation_key,secondary_id,lifecycle_version,evidence_revision,body,digest,response_json,response_sha256 FROM workflow_events WHERE run_id=? ORDER BY ordinal',
      )
      .iterate(run);
    let journal: Journal | null = null;
    for (const record of rows) {
      const { digest, response_json, response_sha256, ...fields } = record;
      demand(workflowDigest(fields) === digest, 'event digest mismatch');
      const row = record as unknown as Entry;
      if (journal) advance(journal, row, checkedJson<Content>(row.body));
      else {
        demand(
          row.kind === 'create' && row.lifecycle_version === 0 && row.evidence_revision === 0,
          'missing first event',
        );
        journal = verifyGenesis(row, genesis);
      }
      demand(
        typeof response_json === 'string' &&
          sha256(response_json) === response_sha256 &&
          canonicalJson(response(journal, row)) === response_json,
        'stored operation result differs from its event',
      );
      execution?.at(journal);
    }
    demand(journal, 'missing genesis event');
    execution?.finish(journal);
    const head = db.prepare('SELECT state,version,revision,ordinal,digest FROM workflow_heads WHERE run_id=?').get(run);
    demand(equal(head, journal.head), 'projection differs from the verified journal');
    return journal;
  } catch (cause) {
    if (
      cause instanceof StateCorruptedError ||
      (cause instanceof ThreadloopError && cause.code === 'WORKFLOW_RUNTIME_UNSUPPORTED')
    )
      throw cause;
    throw new StateCorruptedError('Workflow Run contains invalid stored data.', { cause });
  } finally {
    execution?.close();
  }
}

function response(journal: Journal, row: Entry) {
  switch (row.kind) {
    case 'create':
      return journal.index.create.reply;
    case 'prepare':
      return journal.index.preparations.get(row.operation_key)!.prepared;
    case 'admit':
      return journal.index.admissions.get(row.operation_key)!.reply;
    case 'apply':
      return journal.index.applies.get(row.operation_key)!.reply;
  }
}

function insertEntry(db: DatabaseSync, row: Entry, journal: Journal) {
  // The published response includes this event's digest. Verify its independent bytes on every replay.
  const reply = canonicalJson(response(journal, row));
  db.prepare(
    'INSERT INTO workflow_events (run_id,ordinal,previous,kind,operation_key,secondary_id,lifecycle_version,evidence_revision,body,digest,response_json,response_sha256) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(
    row.run_id,
    row.ordinal,
    row.previous,
    row.kind,
    row.operation_key,
    row.secondary_id,
    row.lifecycle_version,
    row.evidence_revision,
    row.body,
    row.digest,
    reply,
    sha256(reply),
  );
}

export function createJournal(db: DatabaseSync, g: WorkflowGenesis, request: string): RunView {
  checkGraph(g, g.graph_json, '0.1', g.compiled.graph_digest);
  const compiled = g.compiled;
  const graph = db
    .prepare("SELECT graph_json FROM workflow_graphs WHERE schema_version='0.1' AND digest=?")
    .get(compiled.graph_digest);
  if (graph) demand(graph.graph_json === g.graph_json, 'conflicting stored graph bytes');
  else
    db.prepare("INSERT INTO workflow_graphs (schema_version,digest,graph_json) VALUES ('0.1',?,?)").run(
      compiled.graph_digest,
      g.graph_json,
    );
  const genesisJson = canonicalJson(g),
    genesisDigest = sha256(genesisJson);
  db.prepare(
    "INSERT INTO workflow_runs (run_id,schema_version,graph_digest,genesis_json,genesis_digest) VALUES (?,'0.1',?,?,?)",
  ).run(g.run_id, compiled.graph_digest, genesisJson, genesisDigest);
  const row = entry(g.run_id, null, g.run_id, { kind: 'create', request, genesis_digest: genesisDigest });
  const journal = verifyGenesis(row, g);
  const { snapshot, head } = journal;
  insertEntry(db, row, journal);
  db.prepare('INSERT INTO workflow_heads (run_id,state,version,revision,ordinal,digest) VALUES (?,?,?,?,?,?)').run(
    g.run_id,
    head.state,
    head.version,
    head.revision,
    head.ordinal,
    head.digest,
  );
  persistInitialExecution(db, snapshot);
  return snapshot.view;
}

export function appendEntry(
  db: DatabaseSync,
  journal: Journal,
  key: string,
  content: Content,
  secondaryId: string | null = null,
) {
  const previous = journal.head;
  const exec = journal.snapshot.managed_execution;
  if (exec) content = { ...content, execution_head: { revision: exec.revision, digest: exec.digest } };
  const row = entry(journal.snapshot.genesis.run_id, previous, key, content, secondaryId);
  advance(journal, row, content);
  insertEntry(db, row, journal);
  const head = journal.head;
  const executionFence = exec
    ? ' AND EXISTS (SELECT 1 FROM workflow_execution_heads WHERE run_id=? AND revision=? AND digest=? AND active_reservation IS ?)'
    : '';
  const executionParameters = exec
    ? [row.run_id, exec.revision, exec.digest, exec.active?.owner.reservation_id ?? null]
    : [];
  const update = db
    .prepare(
      `UPDATE workflow_heads SET state=?,version=?,revision=?,ordinal=?,digest=?
    WHERE run_id=? AND state=? AND version=? AND revision=? AND ordinal=? AND digest=?` + executionFence,
    )
    .run(
      head.state,
      head.version,
      head.revision,
      head.ordinal,
      head.digest,
      row.run_id,
      previous.state,
      previous.version,
      previous.revision,
      previous.ordinal,
      previous.digest,
      ...executionParameters,
    );
  demand(update.changes === 1, 'projection changed during commit');
}
