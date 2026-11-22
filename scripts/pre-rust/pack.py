"""Build a committed ThreadLoop revision offline from its matching installed lockfile."""

import argparse
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

from proof_package import file_hash, git, offline_environment, require, source_identity


def pack(checkout, revision, output):
    """Build the Git revision offline and write its npm tarball, CLI digest and source provenance."""
    record = source_identity(checkout, revision)
    require(
        git(checkout, "hash-object", "package-lock.json") == record["lock_blob"],
        "Install the dependencies from this revision's lockfile using npm ci",
    )
    require((checkout / "node_modules/.bin/tsup").is_file(), "Run npm ci in the checkout")
    output.mkdir(mode=0o700)  # Refuse to mix the package with an existing measurement.
    with tempfile.TemporaryDirectory(prefix="threadloop-pack-") as temporary:
        scratch = Path(temporary).resolve()
        source = scratch / "source"
        source.mkdir()
        env = offline_environment(scratch)
        archive = scratch / "source.tar"
        subprocess.run(
            ["git", "-C", checkout, "archive", "-o", archive, revision], env=env, check=True, timeout=120
        )
        subprocess.run(["tar", "-xf", archive, "-C", source], check=True, timeout=120)
        # npm pack omits directory symlinks when it bundles the CLI's dependencies.
        shutil.copytree(checkout / "node_modules", source / "node_modules", symlinks=True)
        subprocess.run(["npm", "run", "build"], cwd=source, env=env, check=True, timeout=180)
        (entry,) = json.loads(
            subprocess.check_output(
                ["npm", "pack", "--offline", "--ignore-scripts", "--json", "--pack-destination", output],
                cwd=source,
                env=env,
                timeout=120,
            )
        )
        record.update(
            node=subprocess.check_output(["node", "--version"], text=True).strip(),
            npm=subprocess.check_output(["npm", "--version"], text=True).strip(),
            tarball=entry["filename"],
            sha256=file_hash(output / entry["filename"]),
            cli_sha256=file_hash(source / "dist/cli.js"),
            integrity=entry["integrity"],
            bundled_dependencies=len(entry["bundled"]),
        )
    with (output / "provenance.json").open("x") as stream:
        json.dump(record, stream, indent=2)
        stream.write("\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("checkout", type=Path)
    parser.add_argument("revision", help="full commit SHA to package")
    parser.add_argument("new_directory", type=Path)
    args = parser.parse_args()
    pack(args.checkout.resolve(), args.revision, args.new_directory.resolve())
