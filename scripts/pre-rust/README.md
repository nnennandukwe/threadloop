# Reproduce the TypeScript baseline

These commands build local tarballs, install them offline and exercise the installed commands in disposable Git
repositories. Use a clone with full Git history and its matching `npm ci` installation. The package version is `0.1.0`
across these revisions. Git and SHA-256 identify the builds.

Each comparison uses the named Git revisions and the checkout's installed build tools to rebuild the requested archives
offline. It checks every supplied archive and its CLI against those builds before installing any of them. The dependency
installation in the checkout is a trusted input. An adjacent provenance file alone can't authenticate an archive. Use
the recorded Node and npm build versions to reproduce the exact tarball bytes.

## CLI and storage

Choose a new evidence directory outside the checkout. Each script refuses an existing output. The historic inputs share
the candidate's dependency lock at the measured revision. Use an isolated checkout with the matching lock when that
changes.

```sh
REPO=$(git rev-parse --show-toplevel)
REV=$(git rev-parse HEAD)
EVIDENCE=$(mktemp -d)
RUNS_V1=31388a07566350dfeddc30578d43b8926d5b4e22
PRE_ADOPTION=7c54c2bb8055f00736e3b5f6631e9aecbe0fd212
python3 -B scripts/pre-rust/pack.py "$REPO" "$REV" "$EVIDENCE/current"
python3 -B scripts/pre-rust/pack.py "$REPO" "$RUNS_V1" "$EVIDENCE/runs-v1"
python3 -B scripts/pre-rust/pack.py "$REPO" "$PRE_ADOPTION" "$EVIDENCE/old-storage"
python3 -B scripts/pre-rust/installed_parity.py "$REPO" "$REV" "$EVIDENCE/current" \
  "$EVIDENCE/runs-v1" "$EVIDENCE/old-storage" "$EVIDENCE/installed-parity.json"
python3 -B scripts/pre-rust/managed_rollback.py "$REPO" "$REV" "$EVIDENCE/current" \
  "$EVIDENCE/runs-v1" "$EVIDENCE/managed-rollback.json"
```

Run the last two commands with each supported Node major first on `PATH` and a separate JSON output for each run. The
measured hosts and versions appear in the [readiness report](../../docs/pre-rust-readiness.md). The scripts require
Python 3.9+, Git, npm and a POSIX shell environment for the editor fixture.

The CLI comparison records each declared command's installed help, default and negotiated protocol bytes, representative
error envelopes, Git snapshots, the three Markdown artifacts and a race between two CLI processes. The storage check
reads a store created by the pre-adoption CLI. A separate rollback check changes a v1 Workflow Run checkout with the
current CLI and reopens its offline backup with both packages. It checks audit exports, the state database and read-side
WAL or SHM files separately. WAL is SQLite's write-ahead log. SHM is its shared-memory index.

## Restoring managed execution

Keep the controlling repository, its immutable graph and its enrolled `executor.sqlite` together. Quiesce writers and
verify both databases before copying them. The managed proof runs a full checkpoint, compares file hashes and keeps the
external subject and an invocation counter outside the backup. It restores only fixtures it created, at their original
paths.

1. In the lost-response case, the producer changed the subject and stopped before it reported the effect. Both the
   restored CLI and a repeated delivery hold the Attempt for reconciliation. The independent counter records one
   invocation.
2. In the admitted case, the child committed a signed receipt before outer reporting stopped. The restored CLI imports
   that receipt and the caller can replay the same result. The child retains one invocation. The Workflow Run stays at
   the same lifecycle version.

Restoring a backup discards writes committed afterward. The proof records the discarded legacy transition and any later
outer import. The old CLI can still inspect a supported v1 run in the same database. Its managed-run and child
operations refuse the newer data.
