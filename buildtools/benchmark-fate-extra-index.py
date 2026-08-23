from __future__ import annotations

import subprocess
import sys
from pathlib import Path


def main() -> None:
    """Keep the historical entry point while routing to the schema-7 benchmark."""
    repository = Path(__file__).resolve().parent.parent
    command = [
        "node",
        str(repository / "buildtools" / "benchmark-fe-preview.mjs"),
    ]
    arguments = list(sys.argv[1:])
    if arguments and not arguments[0].startswith("-"):
        command.extend(["--project", arguments.pop(0)])
    arguments = [argument for argument in arguments if argument != "--rebuild"]
    command.extend(arguments)
    completed = subprocess.run(command, cwd=repository, check=False)
    raise SystemExit(completed.returncode)


if __name__ == "__main__":
    main()
