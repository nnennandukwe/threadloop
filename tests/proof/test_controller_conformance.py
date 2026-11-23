"""Exercise the same process launcher used by the external controller harness."""

import json
import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPTS = Path(__file__).resolve().parents[2] / "scripts/controller-conformance"
SPEC = importlib.util.spec_from_file_location("conformance_proof", SCRIPTS / "prove.py")
PROOF = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROOF)


class LockedDependencyTest(unittest.TestCase):
    """Verify the dependency bytes available to the controller build and the harness."""

    def test_staged_resolution_ignores_same_version_change_in_ambient_install(self):
        """Read the locked metadata from a fresh checkout while preserving the caller's local edit."""
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            source = root / "source"
            package = root / "data-package"
            source.mkdir()
            package.mkdir()
            manifest = {"name": "proof-data", "version": "1.0.0", "description": "locked metadata"}
            (package / "package.json").write_text(json.dumps(manifest))
            (source / ".gitignore").write_text("node_modules/\n")
            (source / ".npmrc").write_text("offline=true\naudit=false\nfund=false\nupdate-notifier=false\n")
            (source / "package.json").write_text(
                json.dumps(
                    {
                        "name": "proof-fixture",
                        "version": "1.0.0",
                        "dependencies": {"proof-data": "file:proof-data-1.0.0.tgz"},
                    }
                )
            )
            env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
            env.update(
                GIT_CONFIG_GLOBAL=os.devnull,
                GIT_CONFIG_NOSYSTEM="1",
                npm_config_cache=str(root / "cache"),
                npm_config_offline="true",
                npm_config_userconfig=os.devnull,
                npm_config_update_notifier="false",
                npm_config_audit="false",
            )
            with patch.dict(os.environ, env, clear=True):

                def command(cwd, *argv):
                    """Run a fixture command and return its trimmed stdout on success."""
                    return subprocess.run(
                        argv, cwd=cwd, capture_output=True, text=True, check=True, timeout=60
                    ).stdout.strip()

                command(package, "npm", "pack", "--offline", "--ignore-scripts", "--pack-destination", source)
                command(source, "npm", "install", "--offline", "--ignore-scripts")
                command(source, "git", "init", "-q")
                command(source, "git", "add", ".")
                command(
                    source,
                    "git",
                    "-c",
                    "user.name=Proof Fixture",
                    "-c",
                    "user.email=proof@example.invalid",
                    "commit",
                    "--no-gpg-sign",
                    "-qm",
                    "Pin the data package",
                )
                revision = command(source, "git", "rev-parse", "HEAD")
                original_checkout = PROOF.checkout(source, revision)
                ambient_file = source / "node_modules/proof-data/package.json"
                self.assertEqual(json.loads(ambient_file.read_bytes()), manifest)
                ambient_file.write_text(json.dumps({**manifest, "description": "local metadata"}))
                self.assertEqual(PROOF.checkout(source, revision), original_checkout)
                read_metadata = ("node", "-p", "require('proof-data/package.json').description")
                self.assertEqual(command(source, *read_metadata), "local metadata")

                staged = PROOF.stage_locked_checkout(source, revision, root / "staged")

                self.assertEqual(command(staged, "git", "rev-parse", "HEAD"), revision)
                self.assertEqual(
                    (staged / "package-lock.json").read_bytes(), (source / "package-lock.json").read_bytes()
                )
                self.assertEqual(command(staged, *read_metadata), "locked metadata")
                self.assertEqual(command(source, *read_metadata), "local metadata")


class PublicPacketTest(unittest.TestCase):
    """Check what a researcher can recover from a public packet when the subject fails."""

    def test_failed_rows_exclude_oracle_payloads_transport_diagnostics_and_operator_paths(self):
        """Keep all 38 cases and their identities while publishing only the named fields."""
        inventory = []
        results = []
        for index, operation in enumerate(
            ["compile_graph"] * 3 + ["decide"] * 25 + ["execution_scenario"] * 10, 1
        ):
            binding = {
                "id": f"case_{index:03d}",
                "operation": operation,
                "input_digest": "1" * 64,
                "request_digest": "2" * 64,
            }
            inventory.append(
                {
                    **binding,
                    "fixture_digest": "3" * 64,
                    "graph_digest": None,
                    "source_path": "/private/canary",
                }
            )
            results.append(
                {
                    **binding,
                    "response_digest": "4" * 64,
                    "stdout_sha256": "5" * 64,
                    "stderr_sha256": "6" * 64,
                    "status": "passed",
                }
            )
        for row, state in zip(results, ["nonconforming", "protocol_error", "transport_error"]):
            row.update(
                status=state,
                actual={"console": "/private/canary"},
                expected={"value": "/private/canary"},
                diagnostic="transport read /private/canary",
            )
        packet = {
            "cases": results,
            "passed": 35,
            "failed": 3,
            "protocol_error": 1,
            "transport_error": 1,
            "nonconforming": 1,
            "total": 38,
        }
        sanitized = PROOF.public_cases(packet, inventory)
        self.assertEqual(len(sanitized["cases"]), 38)
        self.assertEqual(sanitized["nonconforming"], 1)
        self.assertEqual(sanitized["cases"][0]["fixture_digest"], "3" * 64)
        self.assertNotIn("/private/canary", json.dumps(sanitized))
        results[0]["request_digest"] = "a" * 64
        with self.assertRaisesRegex(ValueError, "Unbound"):
            PROOF.public_cases(packet, inventory)


class ControllerIsolationTest(unittest.TestCase):
    """Check the operating-system boundary without supplying any fixture answers."""

    @unittest.skipUnless(sys.platform == "darwin", "The measured launcher uses macOS Seatbelt.")
    def test_stalled_control_parent_releases_its_detached_case(self):
        """Bound a stalled Node parent and confirm its independently grouped subject stops writing."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            cases = root / "cases"
            cases.mkdir()
            probe = root / "probe.cjs"
            probe.write_text(
                "const fs = require('node:fs');"
                "fs.writeFileSync('subject-pid', String(process.pid));"
                "setInterval(() => fs.appendFileSync('ticks', '.'), 50).unref();"
                "setTimeout(() => {}, 2400);"
            )
            controller = root / "check-controls.cjs"
            controller.write_text(
                "const fs = require('node:fs');"
                "const {command, root, controlRoot} = JSON.parse(fs.readFileSync(0));"
                "fs.writeFileSync(root + '/parent-pid', String(process.pid));"
                "const child = require('node:child_process').spawn(command[0], command.slice(1), "
                "{detached: true, stdio: 'ignore'});"
                "child.unref();"
                "const copyPid = setInterval(() => {"
                "for (const caseDir of fs.readdirSync(controlRoot)) {"
                "const base = controlRoot + '/' + caseDir;"
                "if (fs.existsSync(base + '/ticks')) {"
                "fs.copyFileSync(base + '/subject-pid', root + '/subject-pid'); clearInterval(copyPid);"
                "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500);"
                "}}}, 20); copyPid.unref();"
                "setTimeout(() => process.stdout.write('{}'), 3300);"
            )
            node = str(Path(shutil.which("node")).resolve())
            command = [
                sys.executable,
                str(SCRIPTS / "launch.py"),
                str(cases),
                node,
                str(probe),
                str(probe),
                str(probe),
            ]
            started = time.monotonic()
            with (
                patch.object(PROOF, "SCRIPTS", root),
                patch.object(PROOF, "CONTROL_PARENT_SECONDS", 1.5),
            ):
                with self.assertRaisesRegex(ValueError, "conformance controls.*deadline"):
                    PROOF.external_checks(
                        node, {"command": command, "root": str(root), "controlRoot": str(cases)}, (cases,)
                    )
            self.assertLess(time.monotonic() - started, 10)
            parent_pid = int((root / "parent-pid").read_text())
            subject_pid = int((root / "subject-pid").read_text())
            self.assertEqual(list(cases.iterdir()), [])
            for pid in (parent_pid, subject_pid):
                with self.assertRaises(ProcessLookupError):
                    os.kill(pid, 0)
        self.assertFalse(root.exists())

    @unittest.skipUnless(sys.platform == "darwin", "The measured launcher uses macOS Seatbelt.")
    def test_private_scratch_and_denied_parent_canary(self):
        """A child can write its case output and receives a kernel denial for an existing parent file."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            cases = root / "cases"
            cases.mkdir()
            canary = root / "private-canary"
            canary.write_text("parent-owned")
            probe = root / "probe.cjs"
            probe.write_text(
                "const fs = require('node:fs');"
                "fs.writeFileSync('output', 'case-owned');"
                "try { fs.readFileSync(process.argv[2]); process.exitCode=1; }"
                "catch (error) { console.log(JSON.stringify([error.code, fs.readFileSync('output','utf8')])); }"
            )
            node = Path(shutil.which("node")).resolve()
            result = subprocess.run(
                [
                    sys.executable,
                    SCRIPTS / "launch.py",
                    cases,
                    node,
                    probe,
                    probe,
                    probe,
                    canary,
                ],
                capture_output=True,
                check=True,
                text=True,
                timeout=10,
            )
            denial, value = json.loads(result.stdout)
            self.assertIn(denial, {"EPERM", "EACCES"})
            self.assertEqual(value, "case-owned")
            self.assertEqual(list(cases.iterdir()), [])
