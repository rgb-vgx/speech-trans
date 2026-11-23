"""Diagnostics sink for events reported by the extension."""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_LOCK = threading.Lock()


def _base_dir() -> Path:
    return Path(os.environ.get("ST_LOG_DIR", _REPO_ROOT / "logs"))


def directory() -> Path:
    return _base_dir()


def write_debug(record: dict) -> None:
    """Generic client-side debug sink (logs/client.log) for diagnostics."""
    try:
        directory_path = _base_dir()
        directory_path.mkdir(parents=True, exist_ok=True)
        path = directory_path / "client.log"
        line = json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%S"), **record}, ensure_ascii=False)
        with _LOCK, path.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    except OSError:
        pass
