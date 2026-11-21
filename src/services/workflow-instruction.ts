import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { VerifiedSigstoreSigner } from '../adapters/crypto/sigstore.js';
import { ThreadloopError } from '../contracts/errors.js';
import { isPlainObject } from '../domain/canonical-json.js';
import type { ParsedSignedReviewReceiptPackage } from '../domain/review.js';
import type { GitObject, Preparation, Receipt, WorkflowGenesis } from '../domain/workflow-run.js';

const instructionPath = '.threadloop-instruction.json';
const maxObjects = 70;
const maxObjectBytes = 128 * 1024;
const maxProofBytes = 2 * 1024 * 1024;

function reject(message: string): never {
  throw new ThreadloopError('SIGNED_RECEIPT_INVALID', message, {
    details: {
      reason: 'instruction_proof',
      hint: 'Provide the reviewed companion commit and its base in the bound repository, and use its exact prepared instruction file.',
    },
  });
}

type ReadObject = (oid: string, kind: GitObject['kind']) => Buffer;

function signedObjects(
  prepared: Preparation,
  parsed: ParsedSignedReviewReceiptPackage,
  signer: VerifiedSigstoreSigner,
  read: ReadObject,
) {
  const pull = parsed.artifact.pull_request;
  const target = prepared.pull_request;
  const subject = prepared.binding.subject;
  if (
    prepared.target.kind !== 'signed-instruction' ||
    !prepared.manifest_json ||
    !target ||
    subject.kind !== 'repository' ||
    signer.sourceRepository !== subject.repository_id ||
    signer.sourceRef !== 'refs/heads/' + target.base_ref ||
    parsed.artifact.source.head_sha !== signer.sourceHeadSha ||
    parsed.artifact.source.ref !== signer.sourceRef ||
    pull.number !== target.number ||
    pull.url !== target.url ||
    pull.base_ref !== target.base_ref
  )
    reject('The signed caller, base and authorization pull request must match the preparation.');

  const base = signer.sourceHeadSha;
  const head = pull.head_sha;
  if (!/^[0-9a-f]{40}$/.test(base) || !/^[0-9a-f]{40}$/.test(head) || base === head)
    reject('The reviewed instruction needs its own Git commit.');
  const commit = (oid: string) => {
    const text = read(oid, 'commit').toString('latin1').split('\n\n', 1)[0]!;
    const lines = text.split('\n');
    const root = /^tree ([0-9a-f]{40})$/.exec(lines[0] ?? '')?.[1];
    if (!root) reject('The instruction commit has an invalid tree.');
    const parents = lines.filter((line) => line.startsWith('parent ')).map((p) => p.slice(7));
    if (parents.some((p) => !/^([0-9a-f]{40})$/.test(p))) reject('The instruction commit has an invalid parent.');
    return { root, parents };
  };
  const start = commit(head);
  const ancestors = new Set<string>();
  const queue = [...start.parents];
  while (queue.length > 0 && queue[0] !== base) {
    const next = queue.shift()!;
    if (ancestors.has(next)) continue;
    ancestors.add(next);
    if (ancestors.size > maxObjects - 5) reject('The authorization branch exceeds the bounded ancestry check.');
    queue.push(...commit(next).parents);
  }
  if (queue[0] !== base) reject('The instruction commit must descend from the authenticated base.');
  const before = treeEntries(read(commit(base).root, 'tree'));
  const after = treeEntries(read(start.root, 'tree'));
  const name = Buffer.from(instructionPath).toString('hex');
  const file = after.get(name);
  if (!file || file.mode !== '100644' || before.get(name)?.oid === file.oid)
    reject('The reviewed change must contain the new regular instruction file.');
  before.delete(name);
  after.delete(name);
  if (
    before.size !== after.size ||
    [...before].some(([key, entry]) => {
      const current = after.get(key);
      return entry.mode !== current?.mode || entry.oid !== current.oid;
    })
  )
    reject('The authorization commit changes another path.');
  if (!read(file.oid, 'blob').equals(Buffer.from(prepared.manifest_json)))
    reject('The approved instruction bytes differ from the prepared bytes.');
}

function treeEntries(raw: Buffer) {
  const entries = new Map<string, { mode: string; oid: string }>();
  let offset = 0;
  while (offset < raw.length) {
    const space = raw.indexOf(32, offset);
    const nul = raw.indexOf(0, space + 1);
    if (space <= offset || nul <= space + 1 || nul + 21 > raw.length) reject('The instruction tree is malformed.');
    const mode = raw.toString('ascii', offset, space);
    const name = raw.subarray(space + 1, nul);
    const key = name.toString('hex');
    if (!['40000', '100644', '100755', '120000', '160000'].includes(mode) || name.includes(47) || entries.has(key))
      reject('The instruction tree has an invalid or repeated entry.');
    entries.set(key, { mode, oid: raw.toString('hex', nul + 1, nul + 21) });
    offset = nul + 21;
  }
  return entries;
}

function objectProof(
  prepared: Preparation,
  parsed: ParsedSignedReviewReceiptPackage,
  signer: VerifiedSigstoreSigner,
  load: ReadObject,
) {
  const objects = new Map<string, GitObject>();
  let bytesRead = 0;
  signedObjects(prepared, parsed, signer, (oid, kind) => {
    const saved = objects.get(oid);
    if (saved) {
      if (saved.kind !== kind) reject('The instruction proof gives one object conflicting types.');
      return Buffer.from(saved.bytes);
    }
    const bytes = load(oid, kind);
    bytesRead += bytes.length;
    if (objects.size >= maxObjects || bytesRead > maxProofBytes || bytes.length > maxObjectBytes)
      reject('The instruction proof exceeds its byte or object limit.');
    const hash = createHash('sha1')
      .update(kind + ' ' + bytes.length + '\0')
      .update(bytes)
      .digest('hex');
    if (hash !== oid) reject('The instruction proof contains bytes with a different Git object ID.');
    objects.set(oid, { oid, kind, bytes });
    return bytes;
  });
  return [...objects.values()];
}

export function readWorkflowInstructionObjects(
  genesis: WorkflowGenesis,
  prepared: Preparation,
  parsed: ParsedSignedReviewReceiptPackage,
  signer: VerifiedSigstoreSigner,
): GitObject[] {
  return objectProof(prepared, parsed, signer, (oid, kind) => {
    try {
      return execFileSync('git', ['--no-replace-objects', '-C', genesis.subject_root, 'cat-file', kind, oid], {
        timeout: 3000,
        maxBuffer: maxObjectBytes,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_OPTIONAL_LOCKS: '0',
          GIT_ALLOW_PROTOCOL: '',
          GIT_NO_LAZY_FETCH: '1',
          GIT_TERMINAL_PROMPT: '0',
        },
      });
    } catch {
      return reject('A required instruction object is unavailable or exceeds its read limit.');
    }
  });
}

export function verifyRetainedInstructionObjects(
  prepared: Preparation,
  parsed: ParsedSignedReviewReceiptPackage,
  signer: VerifiedSigstoreSigner,
  objects: readonly GitObject[],
): void {
  if (objects.length > maxObjects) reject('The retained instruction proof contains too many objects.');
  const supplied = new Map(objects.map((item) => [item.oid, item]));
  const checked = objectProof(prepared, parsed, signer, (oid, kind) => {
    const item = supplied.get(oid);
    if (item?.kind !== kind || item.bytes.length > maxObjectBytes)
      reject('The retained instruction proof is incomplete.');
    return Buffer.from(item.bytes);
  });
  if (checked.length !== objects.length)
    reject('The retained instruction proof includes unrelated or duplicate objects.');
}

export function workflowInstructionPayloads(prepared: Preparation): Receipt['payload'][] {
  if (prepared.target.kind !== 'signed-instruction' || !prepared.manifest_json)
    reject("The preparation doesn't identify a human instruction.");
  const instruction = prepared.target.instruction;
  if (instruction.purpose === 'request_stop') return [{ type: 'stop_requested', reason: instruction.reason }];
  if (instruction.purpose === 'block_run') {
    const block: Receipt['payload'] = {
      type: 'block_evidence',
      reason: instruction.reason,
      recovery: instruction.recovery,
      stop_code: instruction.stop_code,
      prior_state: prepared.binding.source_state,
    };
    return instruction.request_stop ? [{ type: 'stop_requested', reason: instruction.reason }, block] : [block];
  }
  const manifest: unknown = JSON.parse(prepared.manifest_json);
  if (!isPlainObject(manifest) || typeof manifest.enrolled_human !== 'string')
    reject('The approved instruction has no enrolled human.');
  return [
    {
      type: 'human_approval',
      scope: 'recovery',
      approver: { type: 'human', id: manifest.enrolled_human },
      reason: instruction.reason,
    },
  ];
}
