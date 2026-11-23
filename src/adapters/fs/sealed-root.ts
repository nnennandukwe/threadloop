import { sha256 } from '../crypto/sha256.js';
import { canonicalJson } from '../../domain/canonical-json.js';
import { GaapEvidenceError } from '../../domain/gaap-json.js';
import type { DatabaseSync } from './sqlite-driver.js';

export const sealedRootTable =
  'CREATE TABLE root (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL, digest TEXT NOT NULL)';

export function readSealedRoot(database: DatabaseSync): { value: unknown; digest: string } {
  const row = database.prepare('SELECT body,digest FROM root WHERE id=1').get();
  if (!row || typeof row.body !== 'string' || typeof row.digest !== 'string' || sha256(row.body) !== row.digest)
    throw new GaapEvidenceError('state.integrity', 'Executor root is missing or differs from its retained identity.');
  let value: unknown;
  try {
    value = JSON.parse(row.body);
  } catch {
    throw new GaapEvidenceError('state.integrity', 'Executor root must contain canonical JSON.');
  }
  if (canonicalJson(value) !== row.body)
    throw new GaapEvidenceError('state.integrity', 'Executor root must contain canonical JSON.');
  return { value, digest: row.digest };
}

export function writeSealedRoot(database: DatabaseSync, value: unknown, expectedRowDigest?: string): void {
  const body = canonicalJson(value);
  const digest = sha256(body);
  if (expectedRowDigest === undefined) {
    database.prepare('INSERT INTO root (id,body,digest) VALUES (1,?,?)').run(body, digest);
    return;
  }
  const result = database
    .prepare('UPDATE root SET body=?,digest=? WHERE id=1 AND digest=?')
    .run(body, digest, expectedRowDigest);
  if (result.changes !== 1)
    throw new GaapEvidenceError('state.fenced', 'The retained executor root changed before the journal could commit.');
}
