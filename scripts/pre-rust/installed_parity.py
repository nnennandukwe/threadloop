#!/usr/bin/env python3
"""Compare three installed ThreadLoop revisions in disposable Git repositories."""

from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory
import argparse
import json
import platform
import re
from proof_package import PRE_RUNS, RUNS_V1, install, offline_environment
import shutil
import sqlite3
import subprocess

args = argparse.ArgumentParser(description=__doc__)
args.add_argument("checkout", type=Path, help="checkout containing the source revisions")
args.add_argument("revision", help="full SHA of the candidate package")
args.add_argument("candidate", type=Path, help="directory from pack.py")
args.add_argument("rollback", type=Path, help="directory from pack.py")
args.add_argument("pre_adoption", type=Path, help="package from the original program baseline")
args.add_argument("new_report", type=Path)
opt = args.parse_args()
if not __debug__:
    args.error("This proof requires active assertions. Run Python without -O.")
if opt.new_report.exists():
    args.error("Supply a fresh output filename.")
report = {
    "host": platform.platform(),
    "packages": {},
    "protocol": {},
    "help": {},
    "failure_envelopes": [],
    "reader_sidecars": {},
}
original = "750ae36b6b7b6ea34081a8c90236d8c95f71b086"


def digest(value):
    """Return the SHA-256 hex digest of the supplied bytes."""
    return sha256(value).hexdigest()


def raw(*args, cwd=None):
    """Run a command in the proof environment and return its stdout bytes on success."""
    return subprocess.check_output(args, cwd=cwd, env=env, stderr=subprocess.PIPE, timeout=60)


def git_object(revision, name):
    """Read the exact bytes of a tracked path at the specified revision."""
    return raw("git", "-C", opt.checkout.resolve(), "show", revision + ":" + name)


def run(binary, cwd, *args):
    """Capture an installed CLI command's exit status, stdout and stderr within 45 seconds."""
    return subprocess.run([binary, *args], cwd=cwd, env=env, capture_output=True, timeout=45)


def ok(binary, cwd, *args):
    """Return the CLI's stdout after checking for a zero exit status and empty stderr."""
    out = run(binary, cwd, *args)
    assert out.returncode == 0 and not out.stderr, (args, out.returncode, out.stderr[:900])
    return out.stdout


def data(binary, cwd, *args):
    """Request JSON output and return the data from a successful CLI response."""
    val = json.loads(ok(binary, cwd, *args, "--json"))
    assert val["ok"] is True
    return val["data"]


def rejected(binary, cwd, args, code):
    """Check the CLI's error code, output stream and exit status, then record the refusal."""
    out = run(binary, cwd, *args, "--json")
    assert out.returncode == 1 and not out.stdout, (args, out.returncode, out.stdout[:400])
    value = json.loads(out.stderr)
    assert value["ok"] is False and value["error"]["code"] == code, (args, code, value)
    report["failure_envelopes"].append(
        {"operation": args[:2], "code": code, "exit": out.returncode, "stream": "stderr"}
    )


def git_repo(name):
    """Create a disposable Git repository on main with one committed README."""
    path = temp / name
    path.mkdir()
    raw("git", "init", "-qb", "main", path)
    for key, value in [
        ("user.name", "Parity Test"),
        ("user.email", "parity@example.invalid"),
        ("commit.gpgsign", "false"),
    ]:
        raw("git", "config", key, value, cwd=path)
    (path / "README.md").write_text("# Parity\n")
    raw("git", "add", "README.md", cwd=path)
    raw("git", "commit", "-qm", "Initial subject", cwd=path)
    return path


def dbfile(repo):
    """Return the path to the session database inside the fixture repository."""
    return repo / ".threadloop/state/state.db"


def fingerprints(repo):
    """Hash the state database and every state.db sidecar present in its directory."""
    db = dbfile(repo)
    return {p.name: digest(p.read_bytes()) for p in db.parent.glob("state.db*") if p.is_file()}


def committed_files(files):
    """Omit shared-memory indexes and empty write-ahead logs when comparing database fingerprints."""
    return {
        k: v
        for k, v in files.items()
        if not k.endswith("-shm") and not (k.endswith("-wal") and v == digest(b""))
    }


def reads(binary, repo, session, label):
    """Hash session and audit output and verify the reads preserve committed database bytes."""
    before = fingerprints(repo)
    args = ["--session", session, "--json"]
    checks = {
        " ".join(cmd): digest(ok(binary, repo, *cmd, *args))
        for cmd in [("session", "status"), ("session", "next"), ("audit", "show"), ("audit", "verify")]
    }
    export = temp / (label + ".jsonl")
    data(binary, repo, "audit", "export", "--session", session, "--output", str(export))
    checks["audit export"] = digest(export.read_bytes())
    after = fingerprints(repo)
    assert committed_files(after) == committed_files(before), (label, before, after)
    report["reader_sidecars"][label] = {"before": before, "after": after}
    return checks


def fresh_protocol(binary, version):
    """Hash both protocol outputs and collect the advertised commands, versions and capabilities."""
    view = ["--contract", version] if version else []
    enc = ok(binary, temp, "protocol", *view, "--json")
    plain = ok(binary, temp, "protocol", *view)
    info = json.loads(enc)["data"]
    return {
        "json_sha256": digest(enc),
        "text_sha256": digest(plain),
        "commands": info["commands"],
        "contractVersions": info["contractVersions"],
        "capabilities": info.get("capabilities", []),
    }


with TemporaryDirectory(prefix="threadloop-parity-") as owned:
    temp = Path(owned).resolve()
    env = {
        **offline_environment(temp),
        "TMPDIR": str(temp),
        "NODE_NO_WARNINGS": "1",
        "NO_COLOR": "1",
        "GIT_CEILING_DIRECTORIES": str(temp.parent),
        "TZ": "UTC",
    }

    def installed(label, directory, revision):
        """Install the specified revision, record its package provenance and return the verified CLI path."""
        cli, record = install(opt.checkout.resolve(), directory.resolve(), revision, temp / label, env)
        report["packages"][label] = record
        return cli

    report["node"] = raw("node", "--version").decode().strip()
    candidate = installed("candidate", opt.candidate, opt.revision)
    old = installed("rollback", opt.rollback, RUNS_V1)
    report["versions"] = {
        name: ok(binary, temp, "--version").decode().strip()
        for name, binary in [("candidate", candidate), ("rollback", old)]
    }
    for version in ["", "4", "5"]:
        report["protocol"][version or "default"] = fresh_protocol(candidate, version)
    assert report["protocol"]["default"] == report["protocol"]["4"]
    assert (
        report["protocol"]["4"]["json_sha256"]
        == "e5943879bfaf27696f0c791adca0d5510e6e49d5660edfa9beb75931c846ed90"
    )
    assert (
        report["protocol"]["4"]["text_sha256"]
        == "5ac51f9c27359b9f27e717adec58d4b85c3e78e4b721957ed534f2d9a7e40fcf"
    )
    report["rollback_default"] = fresh_protocol(old, "")
    assert report["rollback_default"]["json_sha256"] == report["protocol"]["4"]["json_sha256"]
    assert report["rollback_default"]["text_sha256"] == report["protocol"]["4"]["text_sha256"]
    for name in ["", *report["protocol"]["5"]["commands"]]:
        report["help"][name or "threadloop"] = ok(candidate, temp, *name.split(), "--help").decode()
    missing = run(candidate, temp)
    assert missing.returncode == 1 and not missing.stdout and b"Usage:" in missing.stderr
    report["no_args"] = {"exit": 1, "stderr": missing.stderr.decode()}
    for name in ["start", "capture", "status", "finish", "session finish", "daemon run"]:
        rejected(candidate, temp, name.split(), "INVALID_ARGUMENT")
    rejected(candidate, temp, ["session", "list"], "NOT_GIT_REPOSITORY")
    repo = git_repo("workspace")
    rejected(candidate, repo, ["session", "list"], "THREADLOOP_NOT_INITIALIZED")
    ok(old, repo, "init")
    raw("git", "checkout", "-qb", "feature/parity", cwd=repo)
    (repo / "feature.ts").write_text("export const feature = 1;\n")
    raw("git", "add", "feature.ts", cwd=repo)
    raw("git", "commit", "-qm", "Exercise base-aware scope", cwd=repo)
    session = data(
        old, repo, "session", "start", "Parity session", "--goal", "Verify rollback", "--base", "main"
    )["session_id"]
    pre = reads(old, repo, session, "pre-old")
    pre_db = fingerprints(repo)
    saved = temp / "pre-upgrade"
    shutil.copytree(repo / ".threadloop", saved)
    assert reads(candidate, repo, session, "pre-current") == pre
    rejected(candidate, repo, ["session", "status"], "SESSION_REQUIRED")
    rejected(candidate, repo, ["session", "status", "--session", "absent"], "SESSION_NOT_FOUND")
    rejected(
        candidate, repo, ["session", "start", "test", "--goal", "x", "--base", "absent"], "BASE_REF_NOT_FOUND"
    )
    rejected(candidate, repo, ["session", "reconcile"], "RECONCILE_TARGET_REQUIRED")
    editor = temp / "fixture-editor"
    editor.write_text("#!/bin/sh\nprintf '%s\\n' 'Inspect the parity marker' > \"$1\"\n")
    editor.chmod(0o700)
    env["EDITOR"] = str(editor)
    data(candidate, repo, "session", "capture", "reviewer_guidance", "--session", session, "--edit")
    for cmd in [
        ("heartbeat", "--source", "daemon", "--session", session),
        ("reconcile", "--session", session),
        ("reconcile", "--all"),
    ]:
        data(candidate, repo, "session", *cmd)
    status = data(candidate, repo, "session", "status", "--session", session)
    assert "feature.ts" in status["repo_snapshot"]["changedFiles"], status["repo_snapshot"]
    assert status["session"]["last_heartbeat_source"] == "daemon", status["session"]
    for kind in ["change-brief", "pr-summary", "handoff"]:
        data(candidate, repo, "artifact", "generate", kind)
    artifacts = {p.suffixes[-2]: p.read_text() for p in (repo / ".threadloop/artifacts").glob("*.md")}
    assert len(artifacts) == 3 and "Inspect the parity marker" in artifacts[".pr-summary"]
    assert "feature.ts" in artifacts[".change-brief"] and ".threadloop/" not in artifacts[".change-brief"]
    report["artifacts"] = {k: digest(text.encode()) for k, text in artifacts.items()}
    second_start = data(candidate, repo, "session", "start", "Second session", "--goal-edit")
    second = second_start["session_id"]
    assert second_start["task"]["goal"] == "Inspect the parity marker"
    rejected(candidate, repo, ["artifact", "generate"], "SESSION_AMBIGUOUS")
    assert len(data(candidate, repo, "session", "list")["sessions"]) == 2 and second != session

    def frame(key):
        """Build the framed-transition arguments for a version-zero session using the supplied replay key."""
        return [
            "session",
            "transition",
            "framed",
            "--session",
            session,
            "--expected-state-version",
            "0",
            "--idempotency-key",
            key,
            "--actor",
            "agent",
            "--input",
            "{}",
            "--json",
        ]

    keys = ["parity-left", "parity-right"]
    with ThreadPoolExecutor(max_workers=2) as racers:
        result = list(racers.map(lambda key: run(candidate, repo, *frame(key)), keys))
    assert sorted(x.returncode for x in result) == [0, 1], [(x.returncode, x.stderr[:400]) for x in result]
    winner = next(i for i, x in enumerate(result) if x.returncode == 0)
    assert json.loads(result[1 - winner].stderr)["error"]["code"] == "STATE_VERSION_CONFLICT"
    assert ok(candidate, repo, *frame(keys[winner])) == result[winner].stdout
    report["race"] = {
        "winner": keys[winner],
        "loser": "STATE_VERSION_CONFLICT",
        "replay_sha256": digest(result[winner].stdout),
    }

    revision = report["packages"]["candidate"]["revision"]
    subject = git_repo("subject")
    profile = temp / "quote.yaml"
    profile.write_bytes(git_object(revision, "tests/fixtures/workflow/quote.yaml"))
    setup = temp / "setup.json"
    setup.write_text(
        json.dumps(
            dict(
                schema_version="threadloop.workflow-setup/1",
                subject_workspace=str(subject),
                repository_id="fixture-repository",
                policy=dict(
                    id="fixture-policy",
                    proof_binding_transition_id=None,
                    local_gate_ids=[],
                    independent_gate_ids=[],
                    publication_destination=None,
                ),
                proof_plan=None,
                trusted_sources=None,
                allowed_change_paths=[],
            )
        )
    )
    graph = data(
        candidate, repo, "workflow", "create", "quote", "--profile", str(profile), "--setup", str(setup)
    )
    unsupported = temp / "future.json"
    unsupported.write_text(json.dumps({"schema_version": "threadloop.workflow-setup/999"}))
    rejected(
        candidate,
        repo,
        ["workflow", "create", "future", "--profile", str(profile), "--setup", str(unsupported)],
        "WORKFLOW_RUNTIME_UNSUPPORTED",
    )
    rejected(candidate, repo, ["workflow", "inspect", "future"], "WORKFLOW_RUN_NOT_FOUND")
    profile.write_text("schema_version: invalid\n")
    assert data(candidate, repo, "workflow", "inspect", "quote") == graph
    observed = ok(candidate, repo, "workflow", "decide", "quote", "--json")
    decision = temp / "decision.json"
    decision.write_bytes(observed)
    apply = ["workflow", "apply", "quote", "--decision", str(decision), "--idempotency-key", "parity-apply"]
    data(candidate, repo, *apply)
    reopened = data(candidate, repo, "workflow", "inspect", "quote")
    data(candidate, repo, *apply)
    assert reopened["state"] == "prepared" and reopened["state_version"] == 1
    assert data(candidate, repo, "workflow", "inspect", "quote") == reopened
    report["workflow"] = {
        "graph_digest": graph["graph_digest"],
        "initial": graph["state"],
        "final": reopened["state"],
        "final_version": reopened["state_version"],
        "exact_replay_preserved": True,
    }
    assert data(old, repo, "workflow", "inspect", "quote") == reopened
    report["rollback_workflow_v1"] = "read identical state"
    post = reads(candidate, repo, session, "post-current")
    assert post == reads(old, repo, session, "post-old") and post["audit export"] != pre["audit export"]
    post_db = fingerprints(repo)
    (repo / ".threadloop").rename(temp / "post-upgrade")
    shutil.copytree(saved, repo / ".threadloop")
    assert fingerprints(repo) == pre_db
    assert (
        pre
        == reads(old, repo, session, "restored-old")
        == reads(candidate, repo, session, "restored-current")
    )
    assert len(data(old, repo, "session", "list")["sessions"]) == 1
    rejected(candidate, repo, ["workflow", "inspect", "quote"], "WORKFLOW_RUN_NOT_FOUND")
    report["rollback_proof"] = dict(
        pre_upgrade=pre,
        post_upgrade=post,
        restored=pre,
        pre_files=pre_db,
        post_files=post_db,
        restored_files=fingerprints(repo),
        post_upgrade_session_absent=True,
        post_upgrade_workflow_absent=True,
    )

    jsonrepo = git_repo("legacy-json")
    legacyfile = jsonrepo / ".threadloop/state/state.json"
    legacyfile.parent.mkdir(parents=True)
    historical = {
        "id": "legacy-task",
        "title": "Legacy sentinel",
        "goal": "Verify JSON migration",
        "constraints": [],
        "repoRoot": str(jsonrepo),
        "status": "active",
        "createdAt": "2020-01-01T00:00:00.000Z",
    }
    legacyfile.write_text(
        json.dumps({"tasks": [historical], "sessions": [], "entries": [], "artifacts": [], "active": None})
    )
    json_hash = digest(legacyfile.read_bytes())
    ok(candidate, jsonrepo, "init")
    with closing(sqlite3.connect(dbfile(jsonrepo))) as db:
        assert db.execute("SELECT count(*) FROM tasks WHERE id=?", ("legacy-task",)).fetchone()[0] == 0
        assert db.execute("SELECT value FROM metadata WHERE key='schema_version'").fetchone()[0] == "8"
    assert json_hash == digest(legacyfile.read_bytes())
    one = git_repo("schema-one")
    target = one / ".threadloop"
    (target / "state").mkdir(parents=True)
    shutil.copy(jsonrepo / ".threadloop/config.json", target / "config.json")
    old_store = git_object(original, "src/adapters/fs/sqlite-store.ts").decode()
    ddl = (
        old_store.split("function bootstrapDatabase(db: DatabaseSync) {", 1)[1]
        .split("db.exec(\x60", 1)[1]
        .split("\x60);", 1)[0]
    )
    assert "CREATE TABLE IF NOT EXISTS repo_snapshots" in ddl
    with closing(sqlite3.connect(dbfile(one))) as db:
        db.executescript(ddl)
        db.execute("INSERT INTO metadata (key,value) VALUES ('schema_version','1')")
        db.commit()
    bad_before = fingerprints(one)
    rejected(candidate, one, ["session", "list"], "STATE_CORRUPTED")
    assert committed_files(bad_before) == committed_files(fingerprints(one))
    # A future generation must also survive an attempted initialization.
    future = git_repo("future-generation")
    future_db = dbfile(future)
    future_db.parent.mkdir(parents=True)
    shutil.copy(jsonrepo / ".threadloop/config.json", future / ".threadloop/config.json")
    with closing(sqlite3.connect(future_db)) as db:
        db.execute("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        db.execute("INSERT INTO metadata VALUES ('schema_version','9')")
        db.commit()
    future_before = fingerprints(future)
    rejected(candidate, future, ["session", "list"], "STATE_CORRUPTED")
    assert future_before == fingerprints(future)
    init = run(candidate, future, "init")
    assert init.returncode == 1 and b"Unsupported ThreadLoop schema version: 9" in init.stderr
    assert future_before == fingerprints(future)
    report["storage"] = dict(
        generation=8,
        future_generation_refused_without_writes=future_before,
        legacy_json_sha256=json_hash,
        legacy_task_imported=False,
        generation_one_ddl_revision=original,
        generation_one_ddl_sha256=digest(ddl.encode()),
        rejected_read_preserved_files=bad_before,
    )
    historic = installed("pre_adoption", opt.pre_adoption, PRE_RUNS)
    untouched = git_repo("pre-adoption")
    hist_session = data(
        historic, untouched, "session", "start", "Historical receipts", "--goal", "Retain the audit root"
    )["session_id"]
    before = reads(historic, untouched, hist_session, "old-shape-original")
    old_bytes = committed_files(fingerprints(untouched))
    after = reads(candidate, untouched, hist_session, "old-shape-candidate")
    assert before["audit export"] == after["audit export"] and old_bytes == committed_files(
        fingerprints(untouched)
    )
    with closing(sqlite3.connect("file:" + str(dbfile(untouched)) + "?mode=ro", uri=True)) as conn:
        assert (
            conn.execute(
                "SELECT count(*) FROM sqlite_schema WHERE name IN ('gate_result_catalog','workflow_events')"
            ).fetchone()[0]
            == 0
        )
    lifecycle = data(candidate, untouched, "session", "next", "--session", hist_session)["lifecycle"]
    assert lifecycle["storage_schema_version"] == 8 and "session_next_v1" in lifecycle["storage_capabilities"]
    original_next = data(historic, untouched, "session", "next", "--session", hist_session)
    current_next = data(candidate, untouched, "session", "next", "--session", hist_session)
    current_next["lifecycle"].pop("storage_capabilities")
    assert original_next == current_next
    report["pre_adoption"] = dict(
        original_reads=before,
        candidate_reads=after,
        database=old_bytes,
        catalog_and_workflow_tables_absent=True,
        capabilities=lifecycle["storage_capabilities"],
        next_other_fields_identical=True,
    )
    report["declared_error_codes"] = {
        revision: re.findall(
            r"'([A-Z_]+)'",
            git_object(revision, "src/contracts/errors.ts").decode().split("] as const;", 1)[0],
        )
        for revision in [original, report["packages"]["candidate"]["revision"]]
    }
    assert set(report["declared_error_codes"][original]) <= {
        row["code"] for row in report["failure_envelopes"]
    }
    report["runner_sha256"] = {
        revision: digest(git_object(revision, ".agents/skills/threadloop-runner/SKILL.md"))
        for revision in [
            report["packages"]["candidate"]["revision"],
            report["packages"]["rollback"]["revision"],
            "7c54c2bb8055f00736e3b5f6631e9aecbe0fd212",
        ]
    }
    with opt.new_report.open("x") as summary:
        json.dump(report, summary, indent=2)
        summary.write("\n")
    print(
        f"{len(report['help']) - 1} command help entries verified. Rollback restored the original database and audit export."
    )
