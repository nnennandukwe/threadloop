#!/usr/bin/env python3
"""Verify two managed Workflow Run snapshots with the installed candidate and #170 CLIs."""

import argparse
import base64
import json
import os
from pathlib import Path
import re
import shutil
import signal
import sqlite3
import stat
import subprocess
import tempfile

from hashlib import sha256
from proof_package import RUNS_V1, file_hash, install_packages, require, offline_environment, write_report

OLD_MERGE = "bdf68cc2d3ad915d085aecff47c9181f65fb5205"
RUN = "session_wf_rollback"
LEGACY = "session_wf_previous_reader"
CASE_LIMIT = 64 * 1024 * 1024


def sha(data):
    """Return the SHA-256 hex digest of the supplied bytes."""
    return sha256(data).hexdigest()


def run(args, cwd, env, timeout=65):
    """Run the command within its time limit and capture the exit status and both output streams."""
    return subprocess.run(
        [os.fspath(arg) for arg in args], cwd=cwd, env=env, capture_output=True, timeout=timeout
    )


def success(args, cwd, env):
    """Return stdout on success or report the failed command with its trailing stderr."""
    proc = run(args, cwd, env)
    require(proc.returncode == 0, f"{args[0]} {args[1:3]} exited {proc.returncode}: {proc.stderr[-1600:]!r}")
    return proc.stdout


def cli(binary, cwd, env, args):
    """Request JSON from the installed CLI and check the successful response envelope."""
    output = json.loads(success([binary, *args, "--json"], cwd, env))
    require(output["ok"] is True, f"Unsuccessful result for {args[:2]}")
    return output


def refuse(binary, cwd, env, args, code, reason=None):
    """Verify the refusal on stderr and return its exit status, error code and reason."""
    proc = run([binary, *args, "--json"], cwd, env)
    require(
        proc.returncode == 1 and not proc.stdout.strip(),
        f"Expected refusal for {args[:2]}: {proc.returncode}",
    )
    error = json.loads(proc.stderr)["error"]
    require(error["code"] == code and (reason is None or error["details"]["reason"] == reason), repr(error))
    return {"exit": proc.returncode, "code": error["code"], "reason": error.get("details", {}).get("reason")}


def git(checkout, env, *args):
    """Run Git against the requested checkout and return its trimmed output."""
    return success(["git", "-C", checkout, *args], checkout, env).decode().strip()


def checkpoint(control):
    """Check both databases, truncate their write-ahead logs and return their paths."""
    outer = control / ".threadloop/state/state.db"
    children = list((control / ".threadloop/state").glob("workflow-execution-*/executor.sqlite"))
    require(outer.is_file() and len(children) == 1, "Expected one outer and one child database")
    names = [outer, children[0]]
    for name in names:
        with sqlite3.connect(name, isolation_level=None) as db:
            require(
                db.execute("PRAGMA quick_check").fetchall() == [("ok",)], f"Invalid database at {name.name}"
            )
            require(
                db.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()[0] == 0,
                "A writer still holds the backup",
            )
        db.close()
        wal = Path(str(name) + "-wal")
        require(not wal.exists() or wal.stat().st_size == 0, "Checkpoint left uncopied WAL frames")
    return names


def offline(dbfile):
    """Open an immutable, read-only SQLite connection with named columns."""
    db = sqlite3.connect(dbfile.as_uri() + "?mode=ro&immutable=1", uri=True)
    db.row_factory = sqlite3.Row
    return db


def retained_outputs(root):
    """Measure regular files and directories under a quiescent child outputs directory."""
    paths = {}
    total_bytes = 0

    def visit(name, parent_fd, relative, depth):
        """Read one entry relative to its open parent without following links."""
        nonlocal total_bytes
        require(
            len(paths) < 4096 and depth <= 64, "Retained outputs exceed the fixture's entry or depth limit"
        )
        info = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        if stat.S_ISDIR(info.st_mode):
            paths[relative] = {"kind": "directory"}
            directory = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
            try:
                with os.scandir(directory) as entries:
                    for entry in entries:
                        child_path = entry.name if relative == "." else f"{relative}/{entry.name}"
                        visit(entry.name, directory, child_path, depth + 1)
            finally:
                os.close(directory)
        else:
            require(
                relative != "." and stat.S_ISREG(info.st_mode),
                f"Unsupported retained output kind at {relative}",
            )
            total_bytes += info.st_size
            require(total_bytes < CASE_LIMIT, "Retained outputs exceed the fixture's byte limit")
            flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
            with os.fdopen(os.open(name, flags, dir_fd=parent_fd), "rb") as handle:
                require(
                    stat.S_ISREG(os.fstat(handle.fileno()).st_mode),
                    f"Unsupported retained output kind at {relative}",
                )
                contents = handle.read(info.st_size + 1)
            require(
                len(contents) == info.st_size, f"Retained output changed during measurement at {relative}"
            )
            paths[relative] = {"kind": "file", "bytes": len(contents), "sha256": sha(contents)}

    visit(root, None, ".", 0)
    summary = {
        "entries": len(paths),
        "files": sum(entry["kind"] == "file" for entry in paths.values()),
        "bytes": total_bytes,
        "sha256": sha(json.dumps(paths, sort_keys=True, separators=(",", ":")).encode()),
    }
    return paths, summary


def receipt_state(control):
    """Verify the checkpointed database pair and measure retained child files, receipts and blobs."""
    outer, child = checkpoint(control)
    with offline(outer) as db:
        head = dict(
            db.execute(
                "SELECT state,version,revision,ordinal,digest FROM workflow_heads WHERE run_id=?", (RUN,)
            ).fetchone()
        )
        execution = dict(
            db.execute(
                "SELECT revision,digest,active_reservation FROM workflow_execution_heads WHERE run_id=?",
                (RUN,),
            ).fetchone()
        )
        counts = dict(
            db.execute(
                "SELECT kind,count(*) FROM workflow_execution_events WHERE run_id=? GROUP BY kind", (RUN,)
            )
        )
        legacy_version = db.execute(
            "SELECT version FROM workflow_heads WHERE run_id=?", (LEGACY,)
        ).fetchone()[0]
        outer_integrity = len(db.execute("PRAGMA foreign_key_check").fetchall())
    db.close()
    with offline(child) as db:
        body, retained_hash = db.execute("SELECT body,digest FROM root").fetchone()
        require(sha(body.encode()) == retained_hash, "Child root bytes differ from its digest")
        root = json.loads(body)
        launches = [
            dict(row) for row in db.execute("SELECT attempt,request_digest,output_directory FROM launch")
        ]
        observed = [
            {
                "id": row["id"],
                "status": row["status"],
                "stdout_sha256": sha(row["stdout"]),
                "stderr_sha256": sha(row["stderr"]),
                "envelope_sha256": sha(row["envelope"]) if row["envelope"] else None,
            }
            for row in db.execute("SELECT id,status,stdout,stderr,envelope FROM observation ORDER BY id")
        ]
        receipts = []
        for row in db.execute("SELECT * FROM accepted ORDER BY source_id"):
            signed = json.loads(row["envelope"])
            require(
                base64.b64decode(signed["payload"], validate=True) == row["predicate"],
                "Signed payload differs from the accepted bytes",
            )
            admission = json.loads(row["admission"])
            receipts.append(
                {
                    "source_id": row["source_id"],
                    "source_digest": row["source_digest"],
                    "observation": row["observation_id"],
                    "envelope_sha256": sha(row["envelope"]),
                    "predicate_sha256": sha(row["predicate"]),
                    "admission_digest": admission["admission_digest"],
                    "result_sha256": sha(row["result"].encode()),
                    "signature_count": len(signed["signatures"]),
                }
            )
        blobs = [
            {"id": row["digest"], "bytes": len(row["bytes"]), "sha256": sha(row["bytes"])}
            for row in db.execute("SELECT digest,bytes FROM blob ORDER BY digest")
        ]
        require(all(row["id"] == "sha256:" + row["sha256"] for row in blobs), "Child blob digest mismatch")
        generation = db.execute("PRAGMA user_version").fetchone()[0]
    db.close()
    require(
        outer_integrity == 0 and generation == 2 and root["owner"]["workflow_run_id"] == RUN,
        "Wrong managed database pair",
    )
    output_paths, outputs = retained_outputs(child.parent / "outputs")
    return {
        "files": {str(p.relative_to(control)): file_hash(p) for p in [outer, child]},
        "outer": head,
        "execution": execution,
        "legacy_version": legacy_version,
        "counts": counts,
        "child": {
            "generation": generation,
            "revision": root["revision"],
            "root_sha256": retained_hash,
            "owner": root["owner"],
            "launches": launches,
            "observations": observed,
            "output_paths": output_paths,
            "outputs": outputs,
            "accepted": receipts,
            "blobs": blobs,
        },
    }


def old_reads(previous, root, env, profile, child_relative):
    """Check the prior CLI's managed-run and child refusals, then read the supported legacy run."""
    # The saved v1 proposal projection keeps the old parser's shape and reaches its store reader.
    operations = {
        "inspect": ["workflow", "inspect", RUN],
        "decide": ["workflow", "decide", RUN],
        "apply": [
            "workflow",
            "apply",
            RUN,
            "--decision",
            "previous-decision.json",
            "--idempotency-key",
            "old-apply",
        ],
        "prepare": [
            "workflow",
            "evidence",
            "prepare",
            "signed-gate",
            "--run",
            RUN,
            "--gate",
            "check",
            "--expected-state-version",
            "3",
            "--idempotency-key",
            "old-prepare",
        ],
        "reused_create": ["workflow", "create", RUN, "--profile", profile, "--setup", "legacy.json"],
    }
    results = {
        key: refuse(previous, root, env, args, "WORKFLOW_RUNTIME_UNSUPPORTED")
        for key, args in operations.items()
    }
    for operation in ["inspect", "run"]:
        results["child_" + operation] = refuse(
            previous,
            root,
            env,
            ["executor", operation, "--state", root / child_relative],
            "EXECUTOR_REJECTED",
            "state.version",
        )
    legacy = cli(previous, root, env, ["workflow", "inspect", LEGACY])["data"]
    require(
        legacy["workflow_run_id"] == LEGACY and legacy["state_version"] == 0,
        "Previous supported run is unreadable",
    )
    return {"managed_refusals": results, "legacy_view": legacy}


def counter(log):
    """Read the producer's invocation IDs in order, returning an empty list if the log is absent."""
    return log.read_text().splitlines() if log.exists() else []


def measure_subject(subject, env):
    """Read the physical checkout's HEAD, Git status and effect-file digest for comparison after recovery."""
    effect = subject / "source.txt"
    return {
        "head": git(subject, env, "rev-parse", "HEAD"),
        "status": git(subject, env, "status", "--porcelain=v1", "-uall"),
        "effect_file_sha256": file_hash(effect) if effect.is_file() else None,
    }


def proof_case(case, current, previous, source, scratch, env):
    """Restore a held or admitted execution snapshot and check its receipts, lifecycle and invocation count."""
    counter_dir = scratch / ("counter-" + case)
    counter_dir.mkdir()
    mode = "effect_response_lost" if case == "held" else "success"
    config = json.loads(
        success(
            ["node", "--import", "tsx", "scripts/pre-rust/rollback-fixture.ts", mode, counter_dir],
            source,
            env,
        )
    )
    control, subject, profile = Path(config["control"]), Path(config["subject"]), config["profile"]
    require(
        all(d.resolve().is_relative_to(scratch / "fixtures") for d in [control, subject]),
        "Fixture escaped scratch",
    )
    legacy_subject = scratch / ("legacy-subject-" + case)
    shutil.copytree(subject, legacy_subject, symlinks=True)
    legacy_setup = json.loads((control / "legacy.json").read_text())
    legacy_setup["subject_workspace"] = str(legacy_subject)
    (control / "legacy.json").write_text(json.dumps(legacy_setup))
    success(["git", "init", "-qb", "main"], control, env)
    success([current, "init"], control, env)
    for run_id, setup in [(LEGACY, "legacy.json"), (RUN, "setup.json")]:
        cli(current, control, env, ["workflow", "create", run_id, "--profile", profile, "--setup", setup])

    def saved(id, filename):
        """Save the run's decision envelope in the control checkout and return it to the caller."""
        result = cli(current, control, env, ["workflow", "decide", id])
        (control / filename).write_text(json.dumps(result))
        return result

    for edge in ["frame", "bind_plan", "begin_implementation"]:
        saved(RUN, "edge.json")
        applied = cli(
            current,
            control,
            env,
            ["workflow", "apply", RUN, "--decision", "edge.json", "--idempotency-key", edge],
        )["data"]
        require(applied["transition_id"] == edge, "Expected governed graph progression")
    proposal = saved(RUN, "engineering.json")
    require(
        proposal["data"]["controller_decision"]["decision"]["outcome"] == "engineering_action_required",
        "Expected engineering action",
    )
    prior = json.loads(json.dumps(proposal))
    for key in ["execution_digest", "execution_revision"]:
        del prior["data"]["expectation"][key]
    (control / "previous-decision.json").write_text(json.dumps(prior))
    execute = ["workflow", "execute", RUN, "--decision", "engineering.json"]
    if case == "held":
        initial = refuse(current, control, env, execute, "EXECUTOR_REJECTED", "execution_outstanding")
    else:
        result = run(
            [
                "node",
                "--import",
                source / "tests/fixtures/workflow/execution-cut.mjs",
                current,
                *execute,
                "--json",
            ],
            control,
            {**env, "THREADLOOP_TEST_EXECUTION_CUT": "admit"},
        )
        require(
            result.returncode == -signal.SIGKILL and b"managed-cut=admit" in result.stderr,
            "Missing child admission cut",
        )
        initial = {"signal": "SIGKILL", "observed_boundary": "managed-cut=admit"}
    info = cli(current, control, env, ["workflow", "inspect", RUN])["data"]
    receipt = info["execution"]
    require(
        receipt["disposition"] == ("started" if case == "held" else "admitted")
        and info["state_version"] == 3,
        "Unexpected initial outer state",
    )
    (control / "correlation.json").write_text(json.dumps(receipt["correlation"]))
    recover = [
        "workflow",
        "evidence",
        "import",
        "gaap",
        "--run",
        RUN,
        "--source",
        "correlation.json",
        "--expected-state-version",
        "3",
    ]
    log = counter_dir / "invocations.log"
    initial_count = counter(log)
    require(
        initial_count == [receipt["correlation"]["attempt_id"]],
        "Expected exactly one independently counted invocation",
    )
    observed_subject = measure_subject(subject, env)
    require(
        case != "held"
        or observed_subject["effect_file_sha256"] == sha(b"effect occurred before response loss\n"),
        "Missing physical held effect",
    )
    before = receipt_state(control)
    child_relative = Path(next(p for p in before["files"] if p.endswith("executor.sqlite"))).parent
    facts = before["child"]
    require(
        len(facts["launches"]) == 1
        and facts["launches"][0]["attempt"] == initial_count[0]
        and facts["launches"][0]["request_digest"] == receipt["correlation"]["executor_request_digest"]
        and before["execution"]["active_reservation"] == facts["owner"]["reservation_id"]
        and not before["counts"].get("import"),
        "Invalid initial correlated state",
    )
    require(len(facts["accepted"]) == int(case == "admitted"), "Unexpected signed receipt count")
    # The enrolled launch retains its original absolute path when the control checkout is copied.
    attempt_output = Path(facts["launches"][0]["output_directory"])
    require(
        attempt_output.parent == control / child_relative / "outputs",
        "Launch points outside the child outputs",
    )
    paths = facts["output_paths"]
    if case == "held":
        marker = b"synthetic producer reached its effect"
        require(
            paths.get(f"{attempt_output.name}/effect-observation.txt")
            == {"kind": "file", "bytes": len(marker), "sha256": sha(marker)},
            "Missing the held Attempt's physical effect observation",
        )
    else:
        require(
            bool(facts["blobs"])
            and facts["accepted"][0]["signature_count"] > 0
            and facts["observations"][0]["envelope_sha256"] == facts["accepted"][0]["envelope_sha256"],
            "Missing admitted signed bytes",
        )
        envelope = paths.get(f"{attempt_output.name}/envelope.json", {})
        require(
            envelope.get("sha256") == facts["accepted"][0]["envelope_sha256"]
            and all(
                paths.get(f"{attempt_output.name}/blobs/{blob['sha256']}")
                == {"kind": "file", "bytes": blob["bytes"], "sha256": blob["sha256"]}
                for blob in facts["blobs"]
            ),
            "Physical Attempt outputs differ from the admitted envelope or blobs",
        )
    old_live = old_reads(previous, control, env, profile, child_relative)
    require(receipt_state(control) == before, "Old reader or writer changed the live pair")
    total = sum(p.stat().st_size for p in control.rglob("*") if p.is_file())
    require(total < CASE_LIMIT, "Fixture exceeds its physical snapshot limit")
    backup = scratch / ("backup-" + case)
    shutil.copytree(control, backup, symlinks=True)
    require(receipt_state(backup) == before, "Copied snapshot differs from live files")
    old_backup = old_reads(previous, backup, env, profile, child_relative)
    require(
        old_backup == old_live and receipt_state(backup) == before, "Previous binary changed the backup pair"
    )

    # Advance the live copy after backup. The operator can see exactly which durable facts restoration discards.
    saved(LEGACY, "legacy-edge.json")
    cli(
        current,
        control,
        env,
        ["workflow", "apply", LEGACY, "--decision", "legacy-edge.json", "--idempotency-key", "after-backup"],
    )

    def recover_admitted():
        """Import the retained receipt and verify its admission, Attempt and unchanged run version."""
        first = cli(current, control, env, recover)["data"]
        require(
            first["disposition"] == "imported"
            and first["state_version"] == 3
            and first["attempt_status"] == "succeeded"
            and first["source_digest"] == facts["accepted"][0]["source_digest"]
            and first["admission_digest"] == facts["accepted"][0]["admission_digest"],
            "Import changed the accepted receipt",
        )
        return first

    live_import = recover_admitted() if case == "admitted" else None
    later = receipt_state(control)
    require(
        later["legacy_version"] == 1 and later["counts"].get("import", 0) == int(case == "admitted"),
        "Expected post-backup writes",
    )
    require(later["child"]["outputs"] == facts["outputs"], "Post-backup operations changed child outputs")
    # Only temporary paths created by this driver can reach the restore operation.
    require(
        control.parent == Path(env["TMPDIR"]) and backup.parent == scratch and backup != control,
        "Invalid restoration ownership",
    )
    control.rename(scratch / ("retired-" + case))
    shutil.copytree(backup, control, symlinks=True)
    restored = receipt_state(control)
    require(
        restored == before and measure_subject(subject, env) == observed_subject,
        "Restored files or external physical effect changed",
    )
    restored_info = cli(current, control, env, ["workflow", "inspect", RUN])["data"]
    require(restored_info == info, "Reopened installed inspector differs from the snapshot")
    verified_child = cli(current, control, env, ["executor", "inspect", "--state", control / child_relative])[
        "data"
    ]
    require(
        verified_child["launch_count"] == 1 and verified_child["revision"] == facts["revision"],
        "Verified child belongs to another generation",
    )
    require(receipt_state(control) == restored, "Installed inspectors changed the restored snapshot")
    if case == "held":
        recovered = refuse(current, control, env, recover, "EXECUTOR_REJECTED", "execution_outstanding")
        replay = refuse(current, control, env, execute, "EXECUTOR_REJECTED", "execution_outstanding")
    else:
        recovered = recover_admitted()
        replay = cli(current, control, env, execute)["data"]
        require(
            recovered == live_import == replay and cli(current, control, env, recover)["data"] == replay,
            "Committed import replay mismatch",
        )
    after = receipt_state(control)
    require(
        after["outer"] == before["outer"]
        and after["child"] == before["child"]
        and after["legacy_version"] == 0
        and after["counts"].get("import", 0) == int(case == "admitted")
        and counter(log) == initial_count
        and measure_subject(subject, env) == observed_subject,
        "Recovery repeated a child effect or mutated lifecycle state",
    )
    return {
        "case": case,
        "initial_observation": initial,
        "snapshot_bytes": total,
        "file_hashes_before": before["files"],
        "file_hashes_restored": restored["files"],
        "outputs_before": facts["outputs"],
        "outputs_restored": restored["child"]["outputs"],
        "outer_state_version": info["state_version"],
        "child_root_digest": facts["root_sha256"],
        "child_revision": facts["revision"],
        "execution_revision_before": before["execution"]["revision"],
        "execution_revision_recovered": after["execution"]["revision"],
        "launches": len(facts["launches"]),
        "invocations_after_recovery": len(counter(log)),
        "physical_subject_head": observed_subject["head"],
        "effect_file_sha256": observed_subject["effect_file_sha256"],
        "accepted": facts["accepted"],
        "blobs": facts["blobs"],
        "observations": facts["observations"],
        "old_managed_refusals": old_backup["managed_refusals"],
        "legacy_version_after_backup": later["legacy_version"],
        "legacy_version_restored": restored["legacy_version"],
        "import_events_after_backup": later["counts"].get("import", 0),
        "import_events_restored": restored["counts"].get("import", 0),
        "import_events_after_recovery": after["counts"].get("import", 0),
        "recovery_disposition": recovered.get("disposition", recovered.get("reason")),
        "replay_disposition": replay.get("disposition", replay.get("reason")),
    }


def main():
    """Install both revisions, run both rollback cases and write their evidence to a fresh report."""
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("checkout", type=Path)
    p.add_argument("revision")
    p.add_argument("candidate_package", type=Path)
    p.add_argument("prior_package", type=Path)
    p.add_argument("new_report", type=Path)
    args = p.parse_args()
    require(re.fullmatch("[0-9a-f]{40}", args.revision) is not None, "Expected a full candidate commit SHA")
    checkout = args.checkout.resolve()
    report = args.new_report.resolve()
    require(not report.exists(), "Choose a fresh report filename")
    with tempfile.TemporaryDirectory(prefix="threadloop-managed-rollback-") as directory:
        scratch = Path(directory).resolve()
        fixtures = scratch / "fixtures"
        fixtures.mkdir()
        env = {
            **offline_environment(scratch),
            "TMPDIR": str(fixtures),
            "TMP": str(fixtures),
            "TEMP": str(fixtures),
        }
        require(
            git(checkout, env, "rev-parse", RUNS_V1 + "^{tree}")
            == git(checkout, env, "rev-parse", OLD_MERGE + "^{tree}"),
            "Reviewed #170 tree differs from its merge",
        )
        source = scratch / "source"
        source.mkdir()
        arc = scratch / "fixtures.tar"
        success(
            [
                "git",
                "archive",
                "--format=tar",
                "-o",
                arc,
                args.revision,
                "src",
                "tests",
                "scripts",
                "package.json",
                "package-lock.json",
                "tsconfig.build.json",
                "tsconfig.json",
            ],
            checkout,
            env,
        )
        success(["tar", "-xf", arc, "-C", source], scratch, env)
        arc.unlink()
        require(
            file_hash(source / "package-lock.json") == file_hash(checkout / "package-lock.json"),
            "Installed fixture dependency lock differs from the candidate",
        )
        (source / "node_modules").symlink_to(checkout / "node_modules", target_is_directory=True)
        packages = install_packages(
            checkout,
            {
                "current": (args.candidate_package.resolve(), args.revision),
                "previous": (args.prior_package.resolve(), RUNS_V1),
            },
            scratch,
            env,
        )
        current, csource = packages["current"]
        previous, psource = packages["previous"]
        cases = [proof_case(case, current, previous, source, scratch, env) for case in ["held", "admitted"]]
        packet = {
            "format": "threadloop.managed-rollback-proof/1",
            "driver_sha256": file_hash(Path(__file__).resolve()),
            "node": success(["node", "--version"], scratch, env).decode().strip(),
            "sqlite": sqlite3.sqlite_version,
            "current": csource,
            "old": psource,
            "old_merge": OLD_MERGE,
            "process_fixture": "local fixture producer with fixture signing",
            "fixture_source": {
                p: file_hash(source / p)
                for p in [
                    "scripts/pre-rust/rollback-fixture.ts",
                    "tests/helpers/workflow-execution.ts",
                    "tests/fixtures/workflow/execution-cut.mjs",
                    "tests/fixtures/gaap-producer.ts",
                    "tests/fixtures/gaap.ts",
                ]
            },
            "cases": cases,
        }
    require(not scratch.exists(), "Temporary proof files remain")
    packet["scratch_removed"] = True
    write_report(report, packet, sort_keys=True)
    print(f"{report.name} SHA-256 {file_hash(report)}")


if __name__ == "__main__":
    main()
