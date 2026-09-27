#!/usr/bin/env python3
"""Install this skill without replacing an existing installation."""
import os
from pathlib import Path
import shutil
import sys

source = Path(__file__).resolve().parent / "wechat-prompt-image"
skills_root = Path(sys.argv[1]).expanduser() if len(sys.argv) > 1 else Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))) / "skills"
destination = skills_root / source.name
if destination.exists():
    raise SystemExit(f"Already exists; no files changed: {destination}")
skills_root.mkdir(parents=True, exist_ok=True)
shutil.copytree(source, destination, ignore=shutil.ignore_patterns("node_modules", ".DS_Store", "__pycache__"))
print(f"Installed: {destination}")
