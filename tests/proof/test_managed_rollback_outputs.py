"""Check which retained child output files participate in the managed rollback proof."""

from contextlib import closing
import hashlib
import importlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest


SCRIPTS = Path(__file__).resolve().parents[2] / "scripts/pre-rust"
CHILD = Path(".threadloop/state/workflow-execution-fixture")
ARTIFACT = CHILD / "outputs/attempt-fixture/blobs/evidence"
DATABASES = [Path(".threadloop/state/state.db"), CHILD / "executor.sqlite"]


class RestoredChildOutputsTest(unittest.TestCase):
    """Exercise the snapshot reader that compares the live, copied and restored control trees."""

    def setUp(self):
        """Create the SQLite tables read by the proof and one nested child output."""
        sys.path.insert(0, str(SCRIPTS))
        self.addCleanup(sys.path.remove, str(SCRIPTS))
        self.proof = importlib.import_module("managed_rollback")
        work = tempfile.TemporaryDirectory()
        self.addCleanup(work.cleanup)
        self.scratch = Path(work.name).resolve()
        self.live = self.scratch / "live"
        (self.live / ARTIFACT).parent.mkdir(parents=True)
        (self.live / ARTIFACT).write_bytes(b"retained child evidence\n")
        with closing(sqlite3.connect(self.live / DATABASES[0])) as db:
            db.executescript("""
                CREATE TABLE workflow_heads(run_id, state, version, revision, ordinal, digest);
                CREATE TABLE workflow_execution_heads(run_id, revision, digest, active_reservation);
                CREATE TABLE workflow_execution_events(run_id, kind);
            """)
            db.executemany(
                "INSERT INTO workflow_heads VALUES (?, 'implementing', 3, 1, 0, 'head')",
                [(self.proof.RUN,), (self.proof.LEGACY,)],
            )
            db.execute(
                "INSERT INTO workflow_execution_heads VALUES (?, 2, 'execution', 'reservation')",
                (self.proof.RUN,),
            )
            db.commit()
        with closing(sqlite3.connect(self.live / DATABASES[1])) as db:
            db.executescript("""
                PRAGMA user_version = 2;
                CREATE TABLE root(body, digest);
                CREATE TABLE launch(attempt, request_digest, output_directory);
                CREATE TABLE observation(id, status, stdout, stderr, envelope);
                CREATE TABLE accepted(source_id);
                CREATE TABLE blob(digest, bytes);
            """)
            output_directory = (self.live / ARTIFACT).parents[1]
            db.execute(
                "INSERT INTO launch VALUES (?, ?, ?)", ("attempt-fixture", "request", str(output_directory))
            )
            body = json.dumps({"owner": {"workflow_run_id": self.proof.RUN}, "revision": 2})
            db.execute("INSERT INTO root VALUES (?, ?)", (body, hashlib.sha256(body.encode()).hexdigest()))
            db.commit()

    def test_output_changes_break_the_restored_state_match_with_identical_databases(self):
        """Detect changed, removed and additional output files during the same comparison as restore."""
        baseline = self.proof.receipt_state(self.live)
        for difference in ("changed", "missing", "extra", "renamed", "extra-empty-directory"):
            with self.subTest(difference=difference):
                restored = shutil.copytree(self.live, self.scratch / difference)
                self.assertEqual(self.proof.receipt_state(restored), baseline)
                artifact = restored / ARTIFACT
                if difference == "changed":
                    artifact.write_bytes(b"R" + artifact.read_bytes()[1:])
                elif difference == "missing":
                    artifact.unlink()
                elif difference == "extra":
                    artifact.with_name("extra").write_bytes(artifact.read_bytes())
                elif difference == "renamed":
                    artifact.rename(artifact.with_name("renamed"))
                else:
                    artifact.with_name("empty").mkdir()
                current = self.proof.receipt_state(restored)
                for db in DATABASES:
                    self.assertEqual((restored / db).read_bytes(), (self.live / db).read_bytes())
                self.assertNotEqual(current, baseline)
                if difference in ("changed", "renamed"):
                    actual, expected = current["child"]["outputs"], baseline["child"]["outputs"]
                    self.assertEqual(actual["files"], expected["files"])
                    self.assertEqual(actual["bytes"], expected["bytes"])
                    self.assertNotEqual(actual["sha256"], expected["sha256"])

    @unittest.skipUnless(hasattr(os, "mkfifo"), "The rollback file verifier uses POSIX paths.")
    def test_refuses_output_links_and_special_files_before_reading_them(self):
        """A link or named pipe must fail promptly, including a link at the output root."""
        outside = self.scratch / "outside"
        outside.mkdir()
        canary = outside / "canary"
        canary.write_bytes(b"External fixture file\n")
        original = canary.stat()
        # A mistaken open on the pipe has a five-second deadline in the child test process.
        for kind in ("file-link", "directory-link", "root-link", "fifo"):
            with self.subTest(kind=kind):
                restored = shutil.copytree(self.live, self.scratch / kind)
                outputs = restored / CHILD / "outputs"
                item = (restored / ARTIFACT).with_name("extra")
                if kind == "fifo":
                    os.mkfifo(item)
                elif kind == "root-link":
                    outputs.rename(self.scratch / "original-outputs")
                    outputs.symlink_to(outside, target_is_directory=True)
                else:
                    item.symlink_to(
                        canary if kind == "file-link" else outside,
                        target_is_directory=kind == "directory-link",
                    )
                check = subprocess.run(
                    [
                        sys.executable,
                        "-B",
                        "-c",
                        "import sys\nfrom pathlib import Path\nfrom managed_rollback import receipt_state\n"
                        "try: receipt_state(Path(sys.argv[1]))\n"
                        "except ValueError as error: sys.exit(str(error))",
                        restored,
                    ],
                    cwd=SCRIPTS,
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
                self.assertEqual(check.returncode, 1)
                self.assertIn("Unsupported retained output kind at ", check.stderr)
                self.assertEqual(canary.stat().st_mtime_ns, original.st_mtime_ns)
                self.assertEqual(canary.read_bytes(), b"External fixture file\n")
                self.assertEqual(list(outside.iterdir()), [canary])


if __name__ == "__main__":
    unittest.main()
