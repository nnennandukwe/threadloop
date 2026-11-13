import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from './sqlite-driver.js';
import { requireGaapDirectory } from './gaap-files.js';
import { canonicalJson } from '../../domain/canonical-json.js';
import { sha256 } from '../crypto/sha256.js';
import { GaapEvidenceError } from '../../domain/gaap-json.js';
import type { GaapBinding, GaapHost } from '../../domain/gaap-binding.js';
import type { ExecutionJournal } from 'threadloop-contracts/execution';
import type { ExecutorRequest } from 'threadloop-contracts/executor';

export interface GaapRoot {
  schema_version: 'threadloop.gaap-state/1';
  revision: number;
  binding: GaapBinding;
  host: GaapHost;
  journal: ExecutionJournal;
  authority: string[];
  request: ExecutorRequest;
}
export type GaapStateFault = (point: string) => void;
export class GaapStateCommittedError extends GaapEvidenceError {
  constructor(cause: unknown) {
    super(
      'state.committed_with_warning',
      'State committed, but post-commit reporting or cleanup failed. Inspect before recovery. ' +
        (cause instanceof Error ? cause.message : String(cause)),
    );
  }
}
export class GaapStateCommitUncertainError extends GaapEvidenceError {
  constructor(cause: unknown) {
    super(
      'state.commit_uncertain',
      'The commit outcome is unknown. Retain the state and output files, then inspect before recovery. ' +
        (cause instanceof Error ? cause.message : String(cause)),
    );
  }
}

/** Each operation owns its connection; transactions never span asynchronous work. */
export class GaapState {
  readonly directory: string;
  private readonly filename: string;
  constructor(
    directory: string,
    private readonly fault: GaapStateFault = () => {},
  ) {
    this.directory = path.resolve(directory);
    this.filename = path.join(this.directory, 'executor.sqlite');
  }
  private open(write = false): DatabaseSync {
    this.requireOwnedDirectory();
    if (lstatSync(this.filename).isSymbolicLink() || !lstatSync(this.filename).isFile())
      throw new GaapEvidenceError('state.path', 'Executor state must be an owned regular SQLite file.');
    const database = new DatabaseSync(this.filename, { readOnly: !write });
    try {
      database.exec('PRAGMA busy_timeout=5000');
      const version = database.prepare('PRAGMA user_version').get();
      if (version?.user_version !== 1)
        throw new GaapEvidenceError('state.version', 'Unsupported executor state version.');
      return database;
    } catch (error) {
      database.close();
      throw error;
    }
  }
  initialize(root: GaapRoot): void {
    if (!existsSync(this.directory)) mkdirSync(this.directory, { mode: 0o700 });
    this.requireOwnedDirectory();
    if (existsSync(this.filename))
      throw new GaapEvidenceError(
        'state.exists',
        "Executor state already exists. Inspect it before recovery; don't register another Attempt here.",
      );
    const generation = randomUUID();
    // Exclusive creation prevents a concurrent registrar or a symlink from claiming this filename.
    const descriptor = openSync(this.filename, 'wx', 0o600);
    const created = fstatSync(descriptor);
    closeSync(descriptor);
    let database: DatabaseSync | undefined;
    let committed = false;
    let commitAttempted = false;
    let retain = false;
    try {
      database = new DatabaseSync(this.filename);
      database.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
      database.exec(`
        PRAGMA user_version=1;
        CREATE TABLE root (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL, digest TEXT NOT NULL);
        CREATE TABLE launch (attempt TEXT PRIMARY KEY, request_digest TEXT NOT NULL, output_directory TEXT NOT NULL);
        CREATE TABLE observation (id INTEGER PRIMARY KEY, status TEXT NOT NULL, stdout BLOB NOT NULL, stderr BLOB NOT NULL, envelope BLOB, metadata TEXT NOT NULL);
        CREATE TABLE accepted (source_id TEXT PRIMARY KEY, source_digest TEXT NOT NULL, envelope BLOB NOT NULL, predicate BLOB NOT NULL, result TEXT NOT NULL, admission TEXT NOT NULL, observation_id INTEGER NOT NULL);
        CREATE TABLE blob (digest TEXT PRIMARY KEY, bytes BLOB NOT NULL);
        CREATE TABLE evaluation (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
      `);
      this.writeRoot(database, root);
      this.writeGeneration(database, generation);
      this.fault('register.before_commit');
      commitAttempted = true;
      database.exec('COMMIT');
      committed = true;
    } catch (error) {
      let rolledBack = false;
      try {
        database?.exec('ROLLBACK');
        rolledBack = database !== undefined;
      } catch {
        /* No transaction if BEGIN failed. */
      }
      if (commitAttempted && !rolledBack) {
        // Losing both the commit response and readback can't authorize file removal.
        retain = true;
        try {
          committed = this.persistedGeneration(generation, canonicalJson(root));
        } catch {
          /* Inspection through a fresh connection must resolve the outcome. */
        }
        throw committed ? new GaapStateCommittedError(error) : new GaapStateCommitUncertainError(error);
      }
      throw error;
    } finally {
      try {
        if (database?.isOpen) database.close();
      } finally {
        if (!committed && !retain) {
          const current = lstatSync(this.filename, { throwIfNoEntry: false });
          if (current?.isFile() && current.dev === created.dev && current.ino === created.ino)
            unlinkSync(this.filename);
        }
      }
    }
  }
  private requireOwnedDirectory() {
    requireGaapDirectory(this.directory);
    const directory = lstatSync(this.directory);
    if (directory.uid !== process.getuid?.() || (directory.mode & 0o022) !== 0)
      throw new GaapEvidenceError(
        'state.owner',
        'Executor state requires a host-owned directory without group or other write permission.',
      );
  }
  private readRoot(database: DatabaseSync): GaapRoot {
    const row = database.prepare('SELECT body,digest FROM root WHERE id=1').get();
    if (!row || typeof row.body !== 'string' || sha256(row.body) !== row.digest)
      throw new GaapEvidenceError('state.integrity', 'Executor root is missing or differs from its retained identity.');
    const root = JSON.parse(row.body) as GaapRoot;
    if (
      root.schema_version !== 'threadloop.gaap-state/1' ||
      !Number.isSafeInteger(root.revision) ||
      root.revision < 0 ||
      canonicalJson(root) !== row.body
    )
      throw new GaapEvidenceError('state.integrity', 'Executor root has an unsupported or noncanonical shape.');
    return root;
  }
  private writeRoot(database: DatabaseSync, root: GaapRoot) {
    const bytes = canonicalJson(root);
    database.prepare('INSERT OR REPLACE INTO root VALUES (1,?,?)').run(bytes, sha256(bytes));
  }
  private writeGeneration(database: DatabaseSync, generation: string): void {
    // Additive metadata also supports state-1 databases created before this marker existed.
    database.exec(
      'CREATE TABLE IF NOT EXISTS commit_generation (id INTEGER PRIMARY KEY CHECK(id=1), token TEXT NOT NULL)',
    );
    database.prepare('INSERT OR REPLACE INTO commit_generation VALUES (1,?)').run(generation);
  }
  private persistedGeneration(generation: string, expectedRoot: string): boolean {
    // A writer can see its own uncommitted rows, and a competing transaction can
    // produce the same root. Only an independent read of our token proves this COMMIT.
    const database = this.open();
    try {
      const marker = database.prepare('SELECT token FROM commit_generation WHERE id=1').get();
      return marker?.token === generation && canonicalJson(this.readRoot(database)) === expectedRoot;
    } finally {
      database.close();
    }
  }
  read(): GaapRoot {
    const database = this.open();
    try {
      return this.readRoot(database);
    } finally {
      database.close();
    }
  }
  mutate<T>(expectedRevision: number, operation: (root: GaapRoot, database: DatabaseSync) => T): T {
    const generation = randomUUID();
    const database = this.open(true);
    let committed = false;
    let commitAttempted = false;
    let proposedRoot: string | undefined;
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      database.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
      const root = this.readRoot(database);
      if (root.revision !== expectedRevision)
        throw new GaapEvidenceError(
          'state.fenced',
          'Executor authority changed; retain the response and reconcile this Attempt.',
        );
      const value = operation(root, database);
      root.revision += 1;
      this.writeRoot(database, root);
      this.writeGeneration(database, generation);
      proposedRoot = canonicalJson(root);
      this.fault('state.before_commit');
      commitAttempted = true;
      database.exec('COMMIT');
      committed = true;
      this.fault('state.after_commit');
      outcome = { ok: true, value };
    } catch (error) {
      let failure: unknown = error;
      if (!committed) {
        let rolledBack = false;
        try {
          database.exec('ROLLBACK');
          rolledBack = true;
        } catch {
          /* BEGIN or COMMIT may have ended the transaction. */
        }
        if (commitAttempted && !rolledBack) {
          try {
            committed = proposedRoot !== undefined && this.persistedGeneration(generation, proposedRoot);
          } catch {
            /* A closed or unreadable connection leaves the commit uncertain. */
          }
          if (!committed) failure = new GaapStateCommitUncertainError(error);
        }
      }
      outcome = { ok: false, error: committed ? new GaapStateCommittedError(error) : failure };
    }
    try {
      database.close();
    } catch (error) {
      if (outcome.ok) outcome = { ok: false, error: committed ? new GaapStateCommittedError(error) : error };
    }
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }
  inspect() {
    const database = this.open();
    try {
      database.exec('BEGIN');
      const root = this.readRoot(database);
      const launches = database.prepare('SELECT * FROM launch').all();
      const observations = database.prepare('SELECT * FROM observation ORDER BY id').all();
      const accepted = database.prepare('SELECT * FROM accepted').all();
      const blobs = database.prepare('SELECT * FROM blob').all();
      const evaluations = database.prepare('SELECT * FROM evaluation ORDER BY id').all();
      database.exec('COMMIT');
      return { root, launches, observations, accepted, blobs, evaluations };
    } finally {
      database.close();
    }
  }
  hit(point: string) {
    this.fault(point);
  }
}
