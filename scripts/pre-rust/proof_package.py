"""Verify and install revision-specific ThreadLoop packages in a disposable proof directory."""

from hashlib import sha256
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

PRE_RUNS = "7c54c2bb8055f00736e3b5f6631e9aecbe0fd212"
RUNS_V1 = "31388a07566350dfeddc30578d43b8926d5b4e22"


def require(condition, message):
    """Raise ValueError with the supplied explanation when a proof check fails."""
    if not condition:
        raise ValueError(message)


def file_hash(path):
    """Read the file in chunks and return its SHA-256 hex digest."""
    digest = sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(128 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def git_environment():
    """Select the named Git objects in the requested checkout, ignoring local replacement refs."""
    return {
        **{key: value for key, value in os.environ.items() if not key.startswith("GIT_")},
        "GIT_NO_REPLACE_OBJECTS": "1",
    }


def git(checkout, *args):
    """Run Git in the specified checkout and return its trimmed output on success."""
    return subprocess.check_output(
        ["git", "-C", checkout, *args], env=git_environment(), text=True, timeout=60
    ).strip()


def source_identity(checkout, revision):
    """Verify the full commit ID and return its tree ID and package-lock.json blob ID."""
    require(re.fullmatch("[0-9a-f]{40}", revision), "Supply a full commit SHA")
    require(git(checkout, "rev-parse", "--verify", revision + "^{commit}") == revision, "Expected a commit")
    return {
        "revision": revision,
        "tree": git(checkout, "rev-parse", revision + "^{tree}"),
        "lock_blob": git(checkout, "rev-parse", revision + ":package-lock.json"),
    }


def offline_environment(scratch):
    """Create empty Git templates and configure offline npm installs with a scratch-local cache."""
    # Isolate disposable Git commits from the invoking checkout and its hooks or signing identity.
    templates = scratch / "empty-git-templates"
    templates.mkdir()
    return {
        **git_environment(),
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_TEMPLATE_DIR": str(templates),
        "GIT_TERMINAL_PROMPT": "0",
        "npm_config_offline": "true",
        "npm_config_userconfig": os.devnull,
        "npm_config_cache": str(scratch / "npm-cache"),
        "npm_config_update_notifier": "false",
        "npm_config_audit": "false",
        "npm_config_fund": "false",
        "HUSKY": "0",
        "TSX_DISABLE_CACHE": "1",
    }


def write_report(path, record, sort_keys=False):
    """Publish the complete JSON document once, preserving any existing output."""
    encoded = json.dumps(record, indent=2, sort_keys=sort_keys).encode() + b"\n"
    with tempfile.NamedTemporaryFile(dir=path.parent) as staged:
        staged.write(encoded)
        staged.flush()
        os.link(staged.name, path)


def build_revision_package(checkout, revision, output):
    """Build Git's committed bytes offline with the operator's trusted, matching npm ci toolchain."""
    record = source_identity(checkout, revision)
    require(
        git(checkout, "hash-object", "package-lock.json") == record["lock_blob"],
        "Install the dependencies from this revision's lockfile using npm ci",
    )
    require((checkout / "node_modules/.bin/tsup").is_file(), "Run npm ci in the checkout")
    require(not output.exists(), "Choose a fresh package directory.")
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
        archive.unlink()
        # npm pack omits directory symlinks when bundling the CLI's dependencies.
        shutil.copytree(checkout / "node_modules", source / "node_modules", symlinks=True)
        subprocess.run(["npm", "run", "build"], cwd=source, env=env, check=True, timeout=180)
        # npm 10 may run prepare during pack. CI skips Git hook setup in this source archive.
        # Background script output keeps the package listing valid JSON across npm versions.
        (entry,) = json.loads(
            subprocess.check_output(
                [
                    "npm",
                    "pack",
                    "--offline",
                    "--ignore-scripts",
                    "--foreground-scripts=false",
                    "--json",
                    "--pack-destination",
                    scratch,
                ],
                cwd=source,
                env={**env, "CI": "true"},
                timeout=120,
            )
        )
        tarball = scratch / entry["filename"]
        record.update(
            node=subprocess.check_output(["node", "--version"], env=env, text=True, timeout=30).strip(),
            npm=subprocess.check_output(["npm", "--version"], env=env, text=True, timeout=30).strip(),
            tarball=entry["filename"],
            sha256=file_hash(tarball),
            cli_sha256=file_hash(source / "dist/cli.js"),
            integrity=entry["integrity"],
            bundled_dependencies=len(entry["bundled"]),
        )
        output.mkdir(mode=0o700)
        destination = output / record["tarball"]
        try:
            shutil.copyfile(tarball, destination)
            # Readers require the complete provenance file before this package can be used.
            write_report(output / "provenance.json", record)
        except BaseException:
            if not (output / "provenance.json").exists():
                destination.unlink(missing_ok=True)
                output.rmdir()
            raise
    return record


def install_packages(checkout, packages, scratch, env):
    """Authenticate all supplied archives against Git rebuilds before installing any package.

    The operator supplies a trusted npm ci toolchain matching the source lock. One private
    rebuild per revision measures all package bytes. Its Node and npm versions describe
    this independent measurement. The install uses the privately retained rebuild.
    """
    installed = {}
    with tempfile.TemporaryDirectory(dir=scratch, prefix="verified-packages-") as directory:
        rebuilt = {}
        for supplied, revision in packages.values():
            if revision not in rebuilt:
                output = Path(directory) / str(len(rebuilt))
                record = build_revision_package(checkout, revision, output)
                rebuilt[revision] = (record, output / record["tarball"])
            expected, reference_archive = rebuilt[revision]
            claimed = json.loads((supplied / "provenance.json").read_bytes())
            fields = (
                "revision",
                "tree",
                "lock_blob",
                "tarball",
                "sha256",
                "cli_sha256",
                "integrity",
                "bundled_dependencies",
            )
            require(
                isinstance(claimed, dict) and all(claimed.get(k) == expected[k] for k in fields),
                "Package provenance differs from the independent Git rebuild.",
            )
            archive = (supplied / expected["tarball"]).resolve(strict=True)
            require(
                archive.parent == supplied.resolve()
                and archive.is_file()
                and archive.stat().st_size == reference_archive.stat().st_size
                and file_hash(archive) == expected["sha256"],
                "Package archive differs from the independent Git rebuild.",
            )

        for role, (_, revision) in packages.items():
            record, archive = rebuilt[revision]
            prefix = scratch / role
            prefix.mkdir()
            subprocess.run(
                [
                    "npm",
                    "install",
                    "--offline",
                    "--ignore-scripts",
                    "--no-package-lock",
                    "--no-save",
                    "--prefix",
                    prefix,
                    archive,
                ],
                cwd=prefix,
                env=env,
                check=True,
                timeout=120,
                stdout=subprocess.DEVNULL,
            )
            cli = (prefix / "node_modules/.bin/threadloop").resolve(strict=True)
            require(
                cli.is_relative_to(prefix) and file_hash(cli) == record["cli_sha256"], "Installed CLI differs"
            )
            installed[role] = (cli, record)
    return installed
