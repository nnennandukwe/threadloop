"""Launch one controller process under macOS Seatbelt with private case files."""

import os
import subprocess
import sys
import tempfile
from pathlib import Path


def run_with_parent(command, directory, parent):
    """Reap the sandboxed child if its RunInvariant parent exits during a case."""
    if parent <= 1 or os.getppid() != parent:
        raise SystemExit("The case parent exited before launch.")
    child = subprocess.Popen(command, cwd=directory, env={"TZ": "UTC", "LC_ALL": "C", "TMPDIR": directory})
    try:
        while os.getppid() == parent:
            try:
                return child.wait(timeout=0.1)
            except subprocess.TimeoutExpired:
                continue
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=2)
    return child.returncode


def main(arguments):
    """Run the measured Node entry with fresh scratch and pass its exit status to RunInvariant."""
    if sys.platform != "darwin" or not os.access("/usr/bin/sandbox-exec", os.X_OK):
        raise SystemExit("Controller isolation requires macOS and /usr/bin/sandbox-exec.")
    if len(arguments) < 5:
        raise SystemExit("Usage: launch.py CASE_ROOT NODE ENTRY REQUEST_SCHEMA RECEIPT_SCHEMA [ARG ...]")
    import fcntl

    parent = os.getppid()
    root, node, entry, request, receipt = (Path(value).resolve(strict=True) for value in arguments[:5])
    descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    try:
        # The parent can await this directory lock before removing a stopped case's files.
        fcntl.flock(descriptor, fcntl.LOCK_SH)
        with tempfile.TemporaryDirectory(prefix="case-", dir=root) as directory:
            parameters = {
                "NODE": node,
                "ARTIFACT": entry,
                "SCRATCH": directory,
                "REQUEST_SCHEMA": request,
                "RECEIPT_SCHEMA": receipt,
            }
            command = ["/usr/bin/sandbox-exec"]
            for key, value in parameters.items():
                command.extend(["-D", f"{key}={value}"])
            command.extend(["-f", Path(__file__).with_name("subject.sb"), node, entry, *arguments[5:]])
            status = run_with_parent(command, directory, parent)
            return status if status >= 0 else 128 - status
    finally:
        os.close(descriptor)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
