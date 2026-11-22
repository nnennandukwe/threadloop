"""Launch one controller process under macOS Seatbelt with private case files."""

import os
import subprocess
import sys
import tempfile
from pathlib import Path


def main(arguments):
    """Run the measured Node entry with fresh scratch and pass its exit status to RunInvariant."""
    if sys.platform != "darwin" or not os.access("/usr/bin/sandbox-exec", os.X_OK):
        raise SystemExit("Controller isolation requires macOS and /usr/bin/sandbox-exec.")
    if len(arguments) < 5:
        raise SystemExit("Usage: launch.py CASE_ROOT NODE ENTRY REQUEST_SCHEMA RECEIPT_SCHEMA [ARG ...]")
    root, node, entry, request, receipt = (Path(value).resolve(strict=True) for value in arguments[:5])
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
        result = subprocess.run(
            command,
            cwd=directory,
            env={"TZ": "UTC", "LC_ALL": "C", "TMPDIR": directory},
        )
        return result.returncode if result.returncode >= 0 else 128 - result.returncode


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
