import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ThreadloopError } from '../../contracts/errors.js';
import { GaapEvidenceError } from '../../domain/gaap-json.js';
import type { HostSource } from '../../domain/workflow-run.js';
import { readGaapFileDescriptor, requireGaapDirectory } from './gaap-files.js';

type GateSource = Extract<HostSource, { kind: 'local-gate' }>;
type Coordinates = { workflow_run_id: string; key: string; attempt: string };

class ArtifactConflict extends Error {}

function hasCode(error: unknown, code: string) {
  return error instanceof Error && 'code' in error && error.code === code;
}

async function requireOwnedDirectory(directory: string, sync = false) {
  requireGaapDirectory(directory);
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0)
      throw new ArtifactConflict(path.basename(directory) + " isn't an owned, protected directory.");
    if (sync) await handle.sync();
  } finally {
    await handle.close();
  }
}

async function matchesExisting(file: string, expected: Uint8Array): Promise<boolean> {
  requireGaapDirectory(path.dirname(file));
  const name = await lstat(file).catch((error: unknown) => {
    if (hasCode(error, 'ENOENT')) return undefined;
    throw error;
  });
  if (!name) return false;
  if (!name.isFile()) throw new ArtifactConflict(path.basename(file) + " isn't a regular file.");
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.dev !== name.dev ||
      info.ino !== name.ino ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o022) !== 0
    )
      throw new ArtifactConflict(path.basename(file) + " isn't the same owned, protected regular file.");
    if (info.size !== expected.byteLength || !readGaapFileDescriptor(handle.fd, expected.byteLength).equals(expected))
      throw new ArtifactConflict(path.basename(file) + ' differs from the captured gate bytes.');
    await handle.sync();
    return true;
  } finally {
    await handle.close();
  }
}

async function publishMissing(file: string, bytes: Uint8Array) {
  const staged = path.join(path.dirname(file), '.' + randomUUID() + '.tmp');
  const handle = await open(staged, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(staged, file);
    } catch (error) {
      if (!hasCode(error, 'EEXIST') || !(await matchesExisting(file, bytes))) throw error;
    }
  } finally {
    await unlink(staged);
  }
}

/** Restore the captured logs and publish their execution report before admitting the gate. */
export async function restoreWorkflowGateArtifacts(
  root: string,
  coordinates: Coordinates,
  source: GateSource,
): Promise<void> {
  try {
    if (
      !z.uuid().safeParse(coordinates.attempt).success ||
      source.receipt.id !== 'receipt_' + coordinates.attempt ||
      source.receipt.sessionId !== coordinates.workflow_run_id ||
      source.receipt.artifactPath !== 'execution.json' ||
      source.outputs.some((output) => !/^[A-Za-z0-9][A-Za-z0-9._-]*\.log$/.test(output.path))
    )
      throw new ArtifactConflict('The captured result has an invalid attempt or artifact path.');
    let directory = root;
    const directories = [root];
    await requireOwnedDirectory(directory);
    for (const name of ['.threadloop', 'artifacts', 'workflow-collections', coordinates.attempt]) {
      directory = path.join(directory, name);
      if (name !== '.threadloop') {
        try {
          await mkdir(directory, { mode: 0o700 });
        } catch (error) {
          if (!hasCode(error, 'EEXIST')) throw error;
        }
      }
      await requireOwnedDirectory(directory);
      directories.push(directory);
    }
    const files = [...source.outputs, { path: 'execution.json', content: source.artifact }];
    const missing = [];
    for (const entry of files) {
      const file = path.join(directory, entry.path);
      if (!(await matchesExisting(file, entry.content.bytes))) missing.push({ file, bytes: entry.content.bytes });
    }
    for (const entry of missing) await publishMissing(entry.file, entry.bytes);
    // A previous delivery may have linked every name before its directory sync failed.
    for (const owned of directories.reverse()) await requireOwnedDirectory(owned, true);
  } catch (cause) {
    const conflict = cause instanceof ArtifactConflict || cause instanceof GaapEvidenceError;
    throw new ThreadloopError(
      'TRANSITION_GUARD_FAILED',
      conflict ? cause.message : "ThreadLoop captured the gate result but couldn't restore its files.",
      {
        cause,
        details: {
          ...coordinates,
          reason: conflict ? 'collection_artifact_conflict' : 'collection_result_captured',
          hint: conflict
            ? 'Inspect the attempt, preserve conflicting files and retry the original collection in an owned directory.'
            : 'Check the control directory and retry the original collection to restore its captured report and logs.',
        },
      },
    );
  }
}
