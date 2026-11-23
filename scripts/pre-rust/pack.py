"""Build a committed ThreadLoop revision offline from its matching installed lockfile."""

import argparse
from pathlib import Path
from proof_package import build_revision_package as pack


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("checkout", type=Path)
    parser.add_argument("revision", help="full commit SHA to package")
    parser.add_argument("new_directory", type=Path)
    args = parser.parse_args()
    pack(args.checkout.resolve(), args.revision, args.new_directory.resolve())
