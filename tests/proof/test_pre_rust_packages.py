"""Verify the complete npm archives used by the installed parity and rollback proofs."""

import hashlib
import importlib
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts/pre-rust"


class PackageTrustTest(unittest.TestCase):
    """Exercise the offline proof packer and installer with two real Git revisions."""

    def setUp(self):
        """Create a Git project whose build can add a harmless README note during packaging."""
        sys.path.insert(0, str(SCRIPTS))
        self.addCleanup(sys.path.remove, str(SCRIPTS))
        self.proof = importlib.import_module("proof_package")
        work = tempfile.TemporaryDirectory()
        self.addCleanup(work.cleanup)
        self.root = Path(work.name).resolve()
        self.project = self.root / "project"
        self.project.mkdir()
        self.env = {
            **self.proof.offline_environment(self.root),
            "GIT_AUTHOR_NAME": "Package Fixture",
            "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
            "GIT_COMMITTER_NAME": "Package Fixture",
            "GIT_COMMITTER_EMAIL": "fixture@example.invalid",
        }
        (self.project / ".gitignore").write_text("node_modules/\ndist/\n")
        (self.project / "package.json").write_text(
            json.dumps(
                {
                    "name": "threadloop",
                    "version": "0.1.0",
                    "files": ["dist"],
                    "bin": {"threadloop": "dist/cli.js"},
                    "scripts": {"build": "tsup"},
                    "devDependencies": {"fixture-builder": "file:builder"},
                }
            )
        )
        self.cli = b"#!/usr/bin/env node\nconsole.log('Installed package fixture');\n"
        (self.project / "cli.js").write_bytes(self.cli)
        builder = self.project / "builder"
        builder.mkdir()
        (builder / "package.json").write_text(
            json.dumps(
                {
                    "name": "fixture-builder",
                    "version": "1.0.0",
                    "bin": {"tsup": "build.cjs"},
                }
            )
        )
        executable = builder / "build.cjs"
        executable.write_text(
            "#!/usr/bin/env node\n"
            "const fs = require('node:fs');\n"
            "fs.mkdirSync('dist', { recursive: true });\n"
            "fs.copyFileSync('cli.js', 'dist/cli.js');\n"
            "if (process.env.THREADLOOP_FIXTURE_README === '1') {\n"
            "  fs.appendFileSync('README.md', 'Alternate packaging note.\\n');\n"
            "}\n"
        )
        executable.chmod(0o755)
        self.run_command("npm", "install", "--offline", "--ignore-scripts")
        self.run_command("git", "init", "--quiet")
        self.revisions = {}
        for role in ("previous", "candidate"):
            (self.project / "README.md").write_text(f"{role} fixture release\n")
            self.run_command("git", "add", ".")
            self.run_command("git", "commit", "--quiet", "-m", role)
            self.revisions[role] = self.run_command("git", "rev-parse", "HEAD").strip()

    def run_command(self, *argv, env=None):
        """Run a real package or Git command in the isolated fixture project."""
        return subprocess.run(
            argv,
            cwd=self.project,
            env=env or self.env,
            capture_output=True,
            text=True,
            check=True,
            timeout=60,
        ).stdout

    def pack(self, role, readme_note):
        """Run the public pack command and read the archive and its own measured provenance."""
        directory = self.root / (role + ("-note" if readme_note else "-original"))
        self.run_command(
            sys.executable,
            "-B",
            SCRIPTS / "pack.py",
            self.project,
            self.revisions[role],
            directory,
            env={**self.env, "THREADLOOP_FIXTURE_README": "1" if readme_note else "0"},
        )
        record = json.loads((directory / "provenance.json").read_bytes())
        archive = directory / record["tarball"]
        self.assertEqual(hashlib.sha256(archive.read_bytes()).hexdigest(), record["sha256"])
        with tarfile.open(archive, "r:gz") as contents:
            files = {entry.name: contents.extractfile(entry).read() for entry in contents if entry.isfile()}
        return directory, record, files

    def test_candidate_and_previous_packages_require_the_source_built_archive(self):
        """Verify both complete archives before either package can reach the installed proof."""
        packages = {}
        repacked = {}
        digests = {}
        for role in ("candidate", "previous"):
            revision = self.revisions[role]
            original, trusted, first_files = self.pack(role, False)
            changed, alternate, second_files = self.pack(role, True)
            self.assertEqual(trusted["revision"], revision)
            self.assertEqual(alternate["revision"], revision)
            self.assertEqual(trusted["tree"], alternate["tree"])
            self.assertEqual(trusted["lock_blob"], alternate["lock_blob"])
            self.assertNotEqual(trusted["sha256"], alternate["sha256"])
            self.assertEqual(trusted["cli_sha256"], alternate["cli_sha256"])
            self.assertEqual(first_files["package/dist/cli.js"], self.cli)
            self.assertEqual(
                second_files.pop("package/README.md"),
                first_files.pop("package/README.md") + b"Alternate packaging note.\n",
            )
            self.assertEqual(first_files, second_files)
            packages[role] = original, revision
            repacked[role] = changed, revision
            digests[role] = trusted["sha256"]

        for differing_role in packages:
            with self.subTest(differing_role=differing_role):
                scratch = self.root / ("refused-" + differing_role)
                scratch.mkdir()
                with self.assertRaisesRegex(ValueError, "(?i)(archive|tarball|package)"):
                    self.proof.install_packages(
                        self.project,
                        {**packages, differing_role: repacked[differing_role]},
                        scratch,
                        self.env,
                    )
                for role in packages:
                    self.assertFalse((scratch / role).exists())

        scratch = self.root / "accepted"
        scratch.mkdir()
        installed = self.proof.install_packages(self.project, packages, scratch, self.env)
        for role in packages:
            cli, record = installed[role]
            self.assertEqual(record["sha256"], digests[role])
            self.assertEqual((cli.parents[1] / "README.md").read_text(), f"{role} fixture release\n")
            self.assertEqual(self.run_command("node", cli), "Installed package fixture\n")


if __name__ == "__main__":
    unittest.main()
