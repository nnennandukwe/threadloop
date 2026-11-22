"""Verify and install revision-specific ThreadLoop packages in a disposable proof directory."""

from hashlib import sha256
import json
import os
import re
import subprocess

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
    """Copy the environment without inherited GIT_ variables that could select a different repository."""
    return {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}


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


def install(checkout, directory, revision, prefix, env):
    """Verify the source and archive, install offline, and check the installed CLI's digest."""
    record = json.loads((directory / "provenance.json").read_bytes())
    expected = source_identity(checkout, revision)
    require(all(record.get(k) == v for k, v in expected.items()), "Package source identity mismatch")
    archive = (directory / record["tarball"]).resolve()
    require(
        archive.parent == directory.resolve() and file_hash(archive) == record["sha256"],
        "Package tarball digest mismatch",
    )
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
    require(cli.is_relative_to(prefix) and file_hash(cli) == record["cli_sha256"], "Installed CLI differs")
    return cli, record
