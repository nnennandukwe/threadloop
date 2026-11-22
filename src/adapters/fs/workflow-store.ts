import { randomBytes } from 'node:crypto';
import { StateCorruptedError, ThreadloopError } from '../../contracts/errors.js';
import type { Preparation, WorkflowStore } from '../../domain/workflow-run.js';
import { decideWorkflow } from '../../services/workflow-evaluation.js';
import {
  assertExistingStateGeneration,
  StateDatabaseMissingError,
  withExistingStateWrite,
  withReadSnapshot,
} from './sqlite-store.js';
import type { DatabaseSync } from './sqlite-driver.js';
import { appendEntry, createJournal, loadJournal } from './workflow-journal.js';
import { conflict, demand, equal, expectVersion } from './workflow-storage-checks.js';
import { workflowSchema } from './workflow-schema.js';
import { restoreSource, retainSource, signedRaw } from './workflow-stored-source.js';

import type { WorkflowExecutionStore } from '../../domain/workflow-execution.js';
import { ManagedLedgerSchemaError } from './workflow-execution-journal.js';
import { workflowExecutionOperations } from './workflow-execution-store.js';

function missing(run: string): never {
  throw new ThreadloopError('WORKFLOW_RUN_NOT_FOUND', `Workflow Run ${run} doesn't exist.`, {
    details: { reason: 'unknown_run', hint: 'Inspect an existing run ID or create the run.' },
  });
}
function readRun(db: DatabaseSync, run: string) {
  if (!workflowSchema(db)) return missing(run);
  return loadJournal(db, run) ?? missing(run);
}
function synchronously<T>(result: T): T {
  if (result && typeof result === 'object' && 'then' in result) {
    throw new ThreadloopError('INVALID_ARGUMENT', 'Workflow transaction callbacks must return synchronously.');
  }
  return result;
}
function access<T>(action: () => T): T {
  try {
    return action();
  } catch (cause) {
    if (cause instanceof StateDatabaseMissingError)
      throw new ThreadloopError('THREADLOOP_NOT_INITIALIZED', 'The control repository has no state database.', {
        cause,
        details: { reason: 'missing_database', hint: 'Run threadloop init in the control repository.' },
      });
    if (cause instanceof StateCorruptedError)
      throw new ThreadloopError('STATE_CORRUPTED', cause.message, {
        cause,
        details: {
          reason: 'invalid_workflow_storage',
          hint:
            cause instanceof ManagedLedgerSchemaError
              ? cause.hint
              : 'Check the storage generation and restore a verified copy if the run is damaged.',
        },
      });
    if (
      cause instanceof Error &&
      'errcode' in cause &&
      typeof cause.errcode === 'number' &&
      [5, 6].includes(cause.errcode & 255)
    ) {
      throw new ThreadloopError('STATE_BUSY', 'The control database is busy.', {
        cause,
        details: { reason: 'locked_database', hint: 'Retry the same request and key after the writer finishes.' },
      });
    }
    throw cause;
  }
}
function stale(reason: string): never {
  throw new ThreadloopError('STATE_VERSION_CONFLICT', 'The run or its evidence changed before apply.', {
    details: { reason, hint: 'Run workflow decide again and submit its current decision.' },
  });
}
function refuse(reason: string, message: string): never {
  throw new ThreadloopError('TRANSITION_GUARD_FAILED', message, {
    details: { reason, hint: 'Inspect the run, then prepare a new observation with the intended target.' },
  });
}

export function createWorkflowStore(
  root: string,
  now: () => string = () => new Date().toISOString(),
): WorkflowStore & WorkflowExecutionStore {
  const write = <T>(action: (db: DatabaseSync) => T) => access(() => withExistingStateWrite(root, action));
  const read = <T>(action: (db: DatabaseSync) => T) =>
    access(() =>
      withReadSnapshot(root, (db) => {
        assertExistingStateGeneration(db);
        return action(db);
      }),
    );
  return {
    ...workflowExecutionOperations(now, write, readRun),
    read(run) {
      return read((db) => readRun(db, run).snapshot);
    },
    create(run, request, build) {
      return write((db) => {
        workflowSchema(db, true);
        const stored = loadJournal(db, run);
        if (stored) {
          if (stored.index.create.request !== request) conflict('The run ID already has a different create request.');
          return stored.index.create.reply;
        }
        const at = now(),
          genesis = synchronously(build(at));
        demand(genesis.run_id === run && genesis.created_at === at, 'genesis differs from its create request');
        return createJournal(db, genesis, request);
      });
    },
    prepare(run, key, version, target, build) {
      return write((db) => {
        const journal = readRun(db, run);
        const replay = journal.index.preparations.get(key);
        if (replay) {
          if (replay.version !== version || !equal(replay.target, target))
            conflict('The preparation key already has a different request.');
          return replay.prepared;
        }
        expectVersion(journal.snapshot.view.state_version, version);
        if (
          (target.kind === 'signed-review' && journal.index.instructions.has(target.pr)) ||
          (target.kind === 'signed-instruction' && target.pr === journal.snapshot.product_pr?.number)
        ) {
          refuse('product_pr_instruction', 'The product and instruction require separate pull requests.');
        }
        const at = now(),
          id = 'wfr_' + randomBytes(16).toString('hex');
        const prepared = synchronously(build(structuredClone(journal.snapshot), id, at));
        demand(
          prepared.prepared_at === at && prepared.prepared_id === id,
          'preparation callback changed the allocated identity',
        );
        appendEntry(db, journal, key, { kind: 'prepare', version, target, prepared }, id);
        return prepared;
      });
    },
    lookupSigned(run, kind, raw, preparedId) {
      const bytes = signedRaw(raw);
      return read((db) => {
        const { index, snapshot } = readRun(db, run);
        const prior = index.admissions.get(preparedId);
        if (prior) {
          if (!('raw' in prior.record) || prior.record.kind !== kind || !equal(prior.record.raw, bytes))
            conflict('This preparation already accepted different source bytes.');
          return { kind: 'replay', result: prior.reply };
        }
        const prepared = index.byId.get(preparedId);
        if (!prepared || prepared.target.kind !== kind)
          refuse('unknown_preparation', 'No matching preparation exists for this run and source kind.');
        return { kind: 'verify', genesis: snapshot.genesis, prepared };
      });
    },
    admit(run, version, verified, check) {
      const record = retainSource(verified),
        source = restoreSource(record);
      return write((db) => {
        const journal = readRun(db, run);
        const replay = journal.index.admissions.get(source.key);
        if (replay) {
          if (!equal(replay.record, record)) conflict('The source identity already has different content.');
          return replay.reply;
        }
        expectVersion(journal.snapshot.view.state_version, version);
        let prepared: Preparation | null = null;
        if (source.preparedId) {
          prepared = journal.index.byId.get(source.preparedId) ?? null;
          if (!prepared || prepared.target.kind !== verified.kind)
            refuse('unknown_preparation', 'No matching preparation exists for this run and source kind.');
        }
        const batch = synchronously(check(structuredClone(journal.snapshot), structuredClone(prepared), now()));
        const at = now();
        if ((prepared && prepared.valid_until <= at) || (batch.valid_until && batch.valid_until <= at))
          refuse('expired_evidence', 'This observation expired before admission.');
        appendEntry(db, journal, source.key, { kind: 'admit', at, source: record, batch });
        return journal.index.admissions.get(source.key)!.reply;
      });
    },
    apply(run, key, proposal, check) {
      return write((db) => {
        const journal = readRun(db, run);
        const replay = journal.index.applies.get(key);
        if (replay) {
          if (!equal(replay.proposal, proposal)) conflict('The apply key already has a different decision.');
          return replay.reply;
        }
        const { snapshot } = journal;
        const exec = snapshot.managed_execution;
        if (exec?.active)
          throw new ThreadloopError(
            'TRANSITION_GUARD_FAILED',
            'An outstanding managed execution holds this Workflow Run.',
            {
              details: {
                reason: 'execution_outstanding',
                hint: 'Inspect the run and reconcile the selected execution before applying a transition.',
              },
            },
          );
        if (
          exec &&
          (exec.revision !== proposal.expectation.execution_revision ||
            exec.digest !== proposal.expectation.execution_digest)
        )
          stale('stale_execution_revision');
        expectVersion(snapshot.view.state_version, proposal.expectation.state_version);
        if (snapshot.view.evidence_revision !== proposal.expectation.evidence_revision)
          stale('stale_evidence_revision');
        const applied = synchronously(check(structuredClone(snapshot), now()));
        const at = now(),
          fresh = decideWorkflow(snapshot, applied.observed, at).controller_decision;
        const selected = fresh.decision;
        if (
          selected.outcome !== 'transition_available' ||
          selected.transition_id !== applied.selected.transition_id ||
          !equal(selected.checks, applied.selected.checks)
        )
          stale('expired_decision');
        appendEntry(db, journal, key, {
          kind: 'apply',
          proposal,
          at,
          observed: applied.observed,
          fresh_decision_digest: fresh.decision_digest,
        });
        return journal.index.applies.get(key)!.reply;
      });
    },
  };
}
