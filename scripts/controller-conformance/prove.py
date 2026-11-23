"""Run the frozen external suite against an isolated controller built from a clean ThreadLoop commit."""

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time
from collections import Counter
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parent
REPO = SCRIPTS.parents[1]
HARNESS = "54be0d2240c44ee11b65d5e278a2cb667ee523b4"
CONTRACTS = "4ed9a94a2a089b9ae950d93297f7a6b9b939d3a6"
FREEZE = "7dcf432bc75a68b5ee803c6ebb7346b6bb417f83"
CORPUS_SOURCE = "fde510deca780c7cada8a2e461bd15af0fe4ae88"
CORPUS = "11620588c6f4b39353ea9f77e361a50b5cb0dc970410b1ac10aa8bef13efad84"
COMPATIBILITY = "9590ab51c9081ee2c43f67c0ed1b3453588acdda0e63f259827625971643eadf"
CORPUS_DIR = Path("docs/contracts/controller-conformance-v0.1")
GAAP_DIR = Path("docs/contracts/executor-v0.1/upstream/gaap")
SCHEMAS = [GAAP_DIR / name for name in ("agent-run-request.schema.json", "terminal-run-receipt.schema.json")]
SUBJECT = Path("scripts/executor-contract/subject.mjs")
CONTROL = REPO / "tests/fixtures/controller-conformance/control.mjs"
STATUSES = ("passed", "nonconforming", "protocol_error", "transport_error")
OUTCOMES = {
    "transition_available",
    "engineering_action_required",
    "human_action_required",
    "waiting",
    "blocked",
    "terminal",
}
CONTRACT = {
    "protocol": "threadloop.controller-conformance/0.1",
    "fixture_schema": "threadloop.conformance-fixture/0.1",
    "canonicalization": "threadloop.conformance-json/0.1",
    "digest_profile": "threadloop.conformance-sha256/0.1",
    "request_schema": "threadloop.conformance-request/0.1",
    "response_schema": "threadloop.conformance-response/0.1",
    "manifest_schema": "threadloop.conformance-manifest/0.1",
    "compatibility_schema": "threadloop.conformance-compatibility/0.1",
    "compatibility_digest": COMPATIBILITY,
}
LIMITS = {
    "timeout_ms": 10000,
    "stdin_bytes": 16 * 1024 * 1024 + 1,
    "stdout_bytes": 16 * 1024 * 1024 + 1,
    "stderr_bytes": 1024 * 1024,
}
PARENT_SETUP_SECONDS = 30
GIT_SECONDS = 60
BUILD_SECONDS = 180
INSTALL_SECONDS = 300
INSTALL_FLAGS = ["--ignore-scripts", "--include=dev", "--include=optional", "--no-audit", "--no-fund"]
# RunInvariant allows one second for each process group to close its inherited pipes.
SECONDS_PER_CASE_WITH_CLEANUP = LIMITS["timeout_ms"] // 1000 + 1
HARNESS_PARENT_SECONDS = PARENT_SETUP_SECONDS + 38 * SECONDS_PER_CASE_WITH_CLEANUP
CONTROL_PARENT_SECONDS = PARENT_SETUP_SECONDS + 7 * SECONDS_PER_CASE_WITH_CLEANUP


def require(condition, message):
    """Refuse inconsistent inputs before publishing an evidence claim."""
    if not condition:
        raise ValueError(message)


def digest(data):
    """Hash the supplied bytes without adding framing."""
    return hashlib.sha256(data).hexdigest()


def file_hash(path):
    """Hash a file in bounded chunks, including a host Node executable."""
    result = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def canonical(value):
    """Encode the ASCII manifest entries in the frozen compact property order."""
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def read_json(path):
    """Read a JSON file from the parent process."""
    return json.loads(path.read_bytes())


def git(repo, *arguments):
    """Read a value from the requested Git checkout."""
    return subprocess.check_output(["git", "-C", repo, *arguments], text=True, timeout=GIT_SECONDS).strip()


def checkout(repo, revision):
    """Verify the revision and clean working tree, and record its dependency lock."""
    require(
        git(repo, "rev-parse", "HEAD") == revision and not git(repo, "status", "--porcelain"),
        f"Use a clean checkout at {revision}: {repo}",
    )
    return {
        "revision": revision,
        "tree": git(repo, "rev-parse", "HEAD^{tree}"),
        "lock_sha256": file_hash(repo / "package-lock.json"),
    }


def proof_environment(scratch):
    """Give the proof tools a private home and npm cache for public, noninteractive package reads."""
    tools = [shutil.which(name) for name in ("node", "npm", "git")]
    require(all(tools), "Install Node.js, npm and Git before running the proof.")
    tool_dirs = [str(Path(tool).parent) for tool in tools]
    env = {
        "HOME": str(scratch),
        "TMPDIR": str(scratch),
        "PATH": os.pathsep.join(dict.fromkeys([*tool_dirs, *os.defpath.split(os.pathsep)])),
        "LC_ALL": "C",
        "TZ": "UTC",
        "NODE_OPTIONS": "--no-global-search-paths",
        "npm_config_cache": str(scratch / "npm-cache"),
        "npm_config_userconfig": str(scratch / "user.npmrc"),
        "npm_config_globalconfig": str(scratch / "global.npmrc"),
        "npm_config_update_notifier": "false",
        "npm_config_fetch_retries": "1",
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_ALLOW_PROTOCOL": "file:https",
        "GIT_CONFIG_COUNT": "2",
        "GIT_CONFIG_KEY_0": "url.https://github.com/.insteadOf",
        "GIT_CONFIG_VALUE_0": "ssh://git@github.com/",
        "GIT_CONFIG_KEY_1": "url.https://github.com/.insteadOf",
        "GIT_CONFIG_VALUE_1": "git@github.com:",
    }
    if os.environ.get("npm_config_offline") == "true":
        env["npm_config_offline"] = "true"
    return env


def stage_locked_checkout(source, revision, destination):
    """Install the committed lockfile in a fresh local clone without running package lifecycle scripts."""
    expected = checkout(source, revision)
    env = proof_environment(destination.parent)
    require(not destination.exists(), "Choose a fresh checkout destination.")
    subprocess.run(
        ["git", "clone", "--quiet", "--local", "--shared", "--no-checkout", "--", source, destination],
        env=env,
        check=True,
        timeout=GIT_SECONDS,
    )
    subprocess.run(
        ["git", "-c", "core.hooksPath=" + os.devnull, "checkout", "--quiet", "--detach", revision],
        cwd=destination,
        env=env,
        check=True,
        timeout=GIT_SECONDS,
    )
    subprocess.run(
        ["npm", "ci", *INSTALL_FLAGS],
        cwd=destination,
        env=env,
        check=True,
        timeout=INSTALL_SECONDS,
    )
    require(checkout(destination, revision) == expected, "The staged source or lockfile changed.")
    return destination


def build_contracts_dependency(node, implementation, contracts, env):
    """Verify the Git dependency's installed metadata and build its exports with its own locked compiler."""
    package = implementation / "node_modules/threadloop-contracts"
    metadata = {"LICENSE", "README.md", "package.json"}
    require(
        package.is_dir()
        and not package.is_symlink()
        and {p.name for p in package.iterdir()} - {"node_modules"} == metadata,
        "The fresh contracts install must contain only the pinned package metadata and its dependencies.",
    )
    for name in sorted(metadata):
        item = package / name
        require(
            item.is_file()
            and not item.is_symlink()
            and git(contracts, "hash-object", "--no-filters", str(item))
            == git(contracts, "rev-parse", CONTRACTS + ":" + name),
            "The installed contracts package differs from its pinned Git source: " + name,
        )
    subprocess.run(
        [node, contracts / "scripts/build-package.mjs"],
        cwd=contracts,
        env=env,
        check=True,
        timeout=BUILD_SECONDS,
    )
    # package.json maps ./assets/* to ./dist/docs/contracts/* alongside the generated JavaScript.
    # npm owns the nested dependency versions in the ThreadLoop install.
    (contracts / "dist").rename(package / "dist")


def pinned_inputs(harness, contracts):
    """Verify the harness pins, the frozen source, executable corpus assets and schema inventories."""
    harness_info = checkout(harness, HARNESS)
    contracts_info = checkout(contracts, CONTRACTS)
    require(
        git(contracts, "rev-parse", "v0.1.0^{}") == FREEZE,
        "Restore the v0.1.0 contracts tag.",
    )
    require(
        read_json(REPO / "package-lock.json")["packages"]["node_modules/threadloop-contracts"][
            "resolved"
        ].endswith("#" + CONTRACTS),
        "The installed contracts must use the documented immutable pin.",
    )
    pin = read_json(harness / "threadloop/pin.json")
    require(
        pin["revision"] == CORPUS_SOURCE and pin["corpus_digest"] == CORPUS,
        "The harness corpus pin changed.",
    )

    def corpus_blobs(repo, revision):
        """List the Git object identities of the frozen executable data and canonical vectors."""
        lines = git(repo, "ls-tree", "-r", revision, "--", str(CORPUS_DIR)).splitlines()
        return [line for line in lines if line.endswith((".json", ".canonical"))]

    source_files = corpus_blobs(REPO, CORPUS_SOURCE)
    require(
        len(source_files) == 52
        and source_files == corpus_blobs(contracts, CONTRACTS) == corpus_blobs(contracts, FREEZE),
        "The frozen JSON and canonical vectors differ between repositories or the release tag.",
    )
    home = contracts / CORPUS_DIR
    require(
        len(pin["schemas"]) == 8
        and all(file_hash(home / "schemas" / name) == sha for name, sha in pin["schemas"].items()),
        "A frozen conformance schema differs from the harness pin.",
    )
    descriptor = read_json(home / "compatibility.json")
    require(
        digest(canonical(descriptor)) == COMPATIBILITY,
        "Compatibility descriptor digest differs.",
    )
    domain = {
        row["name"]: {item["path"]: item["sha256"] for item in row["schemas"]}
        for row in descriptor["contracts"]
    }
    require(sum(map(len, domain.values())) == 18, "Expected 18 pinned domain schemas.")
    for family, schemas in domain.items():
        for name, sha in schemas.items():
            require(
                file_hash(contracts / "docs/contracts" / (family + "-v0.1") / "schemas" / name) == sha,
                "Domain schema differs: " + name,
            )
    return {
        "harness": harness_info,
        "contracts": contracts_info,
        "tag_revision": FREEZE,
        "corpus_source_revision": CORPUS_SOURCE,
        "source": pin,
        "domain_schemas": domain,
    }


def measure_build(build, contracts, head):
    """Check the three runtime files against the declared closure and the upstream schemas."""
    runtime = build / "runtime"
    entries = list(runtime.rglob("*"))
    require(
        runtime.is_dir() and not runtime.is_symlink() and all(not entry.is_symlink() for entry in entries),
        "A staged runtime contains a symbolic link.",
    )
    files = sorted(entry.relative_to(runtime) for entry in entries if not entry.is_dir())
    require(
        files == sorted([SUBJECT, *SCHEMAS]) and all((runtime / path).is_file() for path in files),
        "The readable runtime must contain the bundle and two regular schema files.",
    )
    manifest = [
        {
            "bytes": (runtime / path).stat().st_size,
            "path": path.as_posix(),
            "sha256": file_hash(runtime / path),
        }
        for path in files
    ]
    require(
        manifest == read_json(build / "manifest.json"),
        "Runtime bytes differ from their manifest.",
    )
    for path in SCHEMAS:
        require(
            file_hash(runtime / path) == file_hash(contracts / path),
            "An upstream schema changed during staging.",
        )
    identity = {
        "name": "threadloop-controller",
        "revision": head,
        "version": read_json(REPO / "package.json")["version"],
        "artifact_digest": digest(canonical(manifest)),
    }
    require(
        identity == read_json(build / "identity.json"),
        "The controller identity differs from its source or runtime files.",
    )
    meta = read_json(build / "build-metafile.json")
    wire_names = {
        "request.schema.json",
        "response.schema.json",
        "execution-scenario.schema.json",
    }
    for name in meta["inputs"]:
        parts = Path(name).parts
        require(
            not ({"fixtures", "vectors", "tests", "test"} & set(parts))
            and "golden" not in parts
            and (("docs" not in parts) or (Path(name).name in wire_names and "schemas" in parts)),
            "The controller build includes an input outside its public runtime contracts: " + name,
        )
    return identity, manifest


def public_cases(packet, inventory):
    """Keep identities, machine outcomes and digests. Raw diagnostics and expected payloads stay with the parent."""
    cases = packet["cases"]
    require(len(inventory) == len(cases) == 38, "The complete external suite has 38 cases.")
    require(
        Counter(row["operation"] for row in inventory)
        == {"compile_graph": 3, "decide": 25, "execution_scenario": 10},
        "The frozen operation inventory differs.",
    )
    published = []
    for index, (entry, result) in enumerate(zip(inventory, cases), 1):
        require(
            entry["id"] == f"case_{index:03d}"
            and all(
                entry[key] == result[key] for key in ("id", "operation", "input_digest", "request_digest")
            ),
            "Unbound result row.",
        )
        status = result["status"]
        require(status in STATUSES, "Unknown harness status.")
        row = {key: entry[key] for key in ("id", "operation", "fixture_digest", "graph_digest")}
        row["status"] = status
        for field in (
            "input_digest",
            "request_digest",
            "response_digest",
            "stdout_sha256",
            "stderr_sha256",
        ):
            value = result[field]
            require(
                (value is None and status in ("protocol_error", "transport_error"))
                or (isinstance(value, str) and re.fullmatch("[0-9a-f]{64}", value)),
                "Malformed case digest.",
            )
            row[field] = value
        if "result_status" in result:
            require(
                result["result_status"] in ("compiled", "invalid", "decision", "execution"),
                "Unknown result type.",
            )
            row["result_status"] = result["result_status"]
            outcome = result["controller_outcome"]
            require(outcome is None or outcome in OUTCOMES, "Unknown controller outcome.")
            row["controller_outcome"] = outcome
        published.append(row)
    counts = {status: sum(row["status"] == status for row in published) for status in STATUSES}
    counts.update(total=len(published), failed=len(published) - counts["passed"])
    require(
        all(count == packet[key] for key, count in counts.items()),
        "Harness counts differ from the public rows.",
    )
    return {**counts, "cases": published}


def await_case_teardown(roots, label):
    """Wait for interrupted launchers to reap their sandboxed subjects and release their case directories."""
    import fcntl

    deadline = time.monotonic() + 3
    for root in roots:
        descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            while True:
                try:
                    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise ValueError(f"{label} timed out and a case launcher still owns its scratch.")
                    time.sleep(0.02)
        finally:
            os.close(descriptor)


def bounded_parent(label, command, *, seconds, cwd, case_roots=(), data=None, env=None):
    """Bound the Node parent separately from the frozen harness's own per-case process deadlines."""
    try:
        return subprocess.run(command, input=data, capture_output=True, cwd=cwd, env=env, timeout=seconds)
    except subprocess.TimeoutExpired as error:
        # subprocess.run has killed and reaped its direct child. Each detached launcher observes reparenting.
        await_case_teardown(case_roots, label)
        raise ValueError(f"{label} exceeded its {seconds:g}-second deadline.") from error


def external_checks(node, arguments, case_roots=(), *, scripts=None, env=None):
    """Read pinned harness metadata or run its independent negative controls in a separate parent process."""
    inventory = arguments.get("inventoryOnly", False)
    result = bounded_parent(
        "conformance inventory" if inventory else "conformance controls",
        [node, (scripts or SCRIPTS) / "check-controls.cjs"],
        cwd=scripts or SCRIPTS,
        env=env,
        seconds=PARENT_SETUP_SECONDS if inventory else CONTROL_PARENT_SECONDS,
        case_roots=case_roots,
        data=json.dumps(arguments).encode(),
    )
    require(
        result.returncode == 0,
        "RunInvariant control failed: " + result.stderr.decode(errors="replace")[-400:],
    )
    return json.loads(result.stdout)


def write_new(path, data):
    """Make completed output visible at a fresh path with an exclusive link."""
    with tempfile.NamedTemporaryFile(dir=path.parent) as stage:
        stage.write(data)
        stage.flush()
        os.link(stage.name, path)


def measure(args):
    """Run the pinned CLI, project its raw packet, verify the control results and remove case-owned scratch."""
    require(
        sys.platform == "darwin" and os.access("/usr/bin/sandbox-exec", os.X_OK),
        "This proof requires macOS with /usr/bin/sandbox-exec. Run it on a supported macOS host.",
    )
    require(
        not args.output.exists()
        and (
            not args.raw_output
            or (args.raw_output.resolve() != args.output.resolve() and not args.raw_output.exists())
        ),
        "Choose fresh, distinct output files.",
    )
    harness, contracts, build = (
        args.harness.resolve(strict=True),
        args.contracts.resolve(strict=True),
        args.build.resolve(strict=True),
    )
    node = Path(shutil.which("node") or "node").resolve(strict=True)
    head = git(REPO, "rev-parse", "HEAD")
    tree = checkout(REPO, head)
    upstream = pinned_inputs(harness, contracts)
    identity, manifest = measure_build(build, contracts, head)
    node_hash = file_hash(node)
    with tempfile.TemporaryDirectory(prefix="threadloop-controller-proof-") as directory:
        scratch = Path(directory).resolve()
        env = proof_environment(scratch)
        implementation = stage_locked_checkout(REPO, head, scratch / "threadloop")
        staged_contracts = stage_locked_checkout(contracts, CONTRACTS, scratch / "contracts")
        build_contracts_dependency(node, implementation, staged_contracts, env)
        scripts = implementation / "scripts/controller-conformance"
        rebuilt = scratch / "build"
        subprocess.run(
            [node, scripts / "build.mjs", "--output", rebuilt],
            cwd=implementation,
            env=env,
            check=True,
            timeout=BUILD_SECONDS,
        )
        require(
            measure_build(rebuilt, contracts, head) == (identity, manifest),
            "The submitted controller differs from the lockfile-based rebuild. Run npm ci and rebuild it.",
        )
        original_inputs = read_json(build / "build-metafile.json")["inputs"]
        require(
            original_inputs == read_json(rebuilt / "build-metafile.json")["inputs"],
            "The clean rebuild used a different input closure.",
        )
        staged_harness = stage_locked_checkout(harness, HARNESS, scratch / "harness")
        runtime = rebuilt / "runtime"
        cases = scratch / "cases"
        cases.mkdir()
        controls_root = scratch / "controls"
        controls_root.mkdir()
        launcher = [
            sys.executable,
            str(scripts / "launch.py"),
            str(cases),
            str(node),
            str(runtime / SUBJECT),
            *(str(runtime / path) for path in SCHEMAS),
        ]
        command = launcher + ["conformance"]
        control = launcher.copy()
        control[2], control[4] = str(controls_root), str(implementation / CONTROL.relative_to(REPO))
        settings = {
            "harness": str(staged_harness),
            "contracts": str(staged_contracts),
            "identity": identity,
            "command": command,
            "control": control,
            "controlRoot": str(controls_root),
        }
        inventory = external_checks(node, {**settings, "inventoryOnly": True}, scripts=scripts, env=env)
        run = bounded_parent(
            "RunInvariant harness",
            [
                node,
                staged_harness / "bin/run-invariant.js",
                "threadloop",
                "--checkout",
                staged_contracts,
                "--subject",
                rebuilt / "identity.json",
                "--subject-kind",
                "controller",
                "--json",
                "--",
                *command,
            ],
            cwd=scratch,
            env=env,
            seconds=HARNESS_PARENT_SECONDS,
            case_roots=(cases,),
        )
        require(
            run.returncode in (0, 1),
            "RunInvariant configuration failed: " + run.stderr.decode(errors="replace")[-400:],
        )
        raw = json.loads(run.stdout)
        if args.raw_output:
            write_new(args.raw_output, run.stdout)
        require(
            raw["subject"] == identity
            and raw["source"] == upstream["source"]
            and raw["subject_kind"] == "controller"
            and raw["schema"] == "run-invariant.threadloop-packet/0.1",
            "Unexpected runner or subject identity.",
        )
        require(
            raw["contract"] == CONTRACT
            and raw["runner"]["command"] == command
            and raw["runner"]["limits"] == LIMITS,
            "RunInvariant reported a different compatibility descriptor or process.",
        )
        results = public_cases(raw["conformance"], inventory)
        require(
            run.returncode == int(results["failed"] > 0),
            "RunInvariant exit status differs from its results.",
        )
        proof = {"status": "suite_failed"}
        if not results["failed"]:
            private_files = {
                "case": staged_contracts / CORPUS_DIR / "fixtures/case_024.json",
                "shared_values": staged_contracts / CORPUS_DIR / "shared.json",
                "golden": staged_contracts / CORPUS_DIR / "vectors/golden.json",
                "synthetic_subject": staged_harness / "test/fixtures/threadloop-subject.js",
                "build_inputs": rebuilt / "build-metafile.json",
                "parent_identity": rebuilt / "identity.json",
            }
            settings["canaries"] = {name: str(path) for name, path in private_files.items()}
            proof = external_checks(node, settings, (cases, controls_root), scripts=scripts, env=env)[
                "controls"
            ]
            for index in (0, 23):
                row = results["cases"][index]
                repeated = proof[row["id"]]
                require(
                    all(
                        repeated[key] == row[key]
                        for key in ("request_digest", "response_digest", "stdout_sha256")
                    ),
                    "The repeated response differs from RunInvariant's row: " + row["id"],
                )
            results["cases"][0]["graph_digest"] = proof["case_001"]["graph_digest"]
        require(
            measure_build(rebuilt, contracts, head) == (identity, manifest),
            "The measured runtime changed.",
        )
        require(
            checkout(implementation, head) == tree
            and checkout(staged_harness, HARNESS) == upstream["harness"]
            and checkout(staged_contracts, CONTRACTS) == upstream["contracts"],
            "A staged checkout or its lockfile changed during the proof.",
        )
        node_version = subprocess.check_output(
            [node, "--version"], env=env, text=True, timeout=PARENT_SETUP_SECONDS
        ).strip()
        npm_version = subprocess.check_output(
            ["npm", "--version"], env=env, text=True, timeout=PARENT_SETUP_SECONDS
        ).strip()
        if not results["failed"]:
            require(not any(cases.iterdir()), "A completed case retained scratch.")
    require(not scratch.exists(), "The parent retained case scratch after the suite.")
    proof["parent_scratch_removed"] = True
    require(
        checkout(REPO, head) == tree
        and checkout(harness, HARNESS) == upstream["harness"]
        and checkout(contracts, CONTRACTS) == upstream["contracts"]
        and file_hash(node) == node_hash,
        "A proof input changed.",
    )
    report = {
        "schema": "threadloop.controller-proof/1",
        "implementation": tree,
        "upstream": upstream,
        "contract": raw["contract"],
        "subject": identity,
        "artifact_manifest": manifest,
        "controls": proof,
        "runner": {
            "exit": run.returncode,
            "packet_schema": raw["schema"],
            "subject_kind": raw["subject_kind"],
            "raw_packet_sha256": digest(run.stdout),
            "limits": raw["runner"]["limits"],
            "dependency_install": {
                "install_method": "npm ci " + " ".join(INSTALL_FLAGS),
                "npm_version": npm_version,
                "sources": ["implementation", "upstream.contracts", "upstream.harness"],
                "contracts_build": "node scripts/build-package.mjs",
            },
            "parent_deadlines_seconds": {
                "install_per_checkout": INSTALL_SECONDS,
                "git": GIT_SECONDS,
                "build": BUILD_SECONDS,
                "node_version": PARENT_SETUP_SECONDS,
                "inventory": PARENT_SETUP_SECONDS,
                "harness": HARNESS_PARENT_SECONDS,
                "controls": CONTROL_PARENT_SECONDS,
            },
            "report_limits": raw["runner"]["report_limits"],
            "process_cleanup": raw["runner"]["process_cleanup"],
            "shell": raw["runner"]["shell"],
            "claim_boundary": raw["claim_boundary"],
            "platform": platform.mac_ver()[0],
            "architecture": platform.machine(),
            "node_version": node_version,
            "node_sha256": node_hash,
            "launcher_sha256": file_hash(SCRIPTS / "launch.py"),
            "policy_sha256": file_hash(SCRIPTS / "subject.sb"),
            "build_metafile_sha256": file_hash(build / "build-metafile.json"),
        },
        "conformance": results,
    }
    write_new(args.output, (json.dumps(report, indent=2) + "\n").encode())
    print(f"{results['passed']}/{results['total']} passed. Packet SHA-256 {file_hash(args.output)}")
    return run.returncode


def main():
    """Parse explicit local inputs. All published results come from the measured invocation."""
    parser = argparse.ArgumentParser(
        description=__doc__ + " Isolation requires macOS with /usr/bin/sandbox-exec."
    )
    for option in ("harness", "contracts", "build", "output"):
        parser.add_argument("--" + option, required=True, type=Path)
    parser.add_argument(
        "--raw-output",
        type=Path,
        help="Optional new private file for the original RunInvariant packet, including local paths.",
    )
    args = parser.parse_args()
    try:
        return measure(args)
    except (ValueError, KeyError, OSError, subprocess.SubprocessError) as error:
        print(f"Controller proof failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
