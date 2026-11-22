"""Exercise the same process launcher used by the external controller harness."""

import json
import importlib.util
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parents[2] / "scripts/controller-conformance"
SPEC = importlib.util.spec_from_file_location("conformance_proof", SCRIPTS / "prove.py")
PROOF = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROOF)


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
